'use strict';
/**
 * AMPARA – back end
 *  - Recebe denúncias anônimas e gera uma chave (protocolo) única e aleatória para cada uma.
 *  - Guarda no banco apenas o HASH da chave: quem vazar o banco não consegue consultar denúncias.
 *  - Não registra IP, cookies nem nome original dos arquivos enviados.
 *  - Serve também o front end (arquivos da pasta acima).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- configuração
const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TIPOS = [
  'Agressão verbal ou humilhação',
  'Procedimento sem consentimento',
  'Falta de informação',
  'Negativa de acompanhante',
  'Negativa de atendimento ou alívio da dor',
  'Outro',
];
const SERVICOS = ['Público (SUS)', 'Privado', 'Convênio / plano de saúde'];
const MOMENTOS = ['Pré-natal', 'Parto', 'Pós-parto', 'Aborto / perda gestacional'];
const STATUS = ['recebida', 'em_analise', 'encaminhada', 'concluida'];

const MAX_ARQUIVOS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------- banco (SQLite)
function abrirBanco(arquivo) {
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS denuncias (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash        TEXT NOT NULL UNIQUE,      -- SHA-256 da chave; a chave em si nunca é guardada
      criada_em       TEXT NOT NULL,             -- só a data (AAAA-MM-DD), sem hora, para reduzir rastreio
      atualizada_em   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'recebida',
      descricao       TEXT,
      local           TEXT,
      data_ocorrencia TEXT,
      servico         TEXT,
      momento         TEXT
    );

    CREATE TABLE IF NOT EXISTS denuncia_tipos (
      denuncia_id INTEGER NOT NULL REFERENCES denuncias(id) ON DELETE CASCADE,
      tipo        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidencias (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      denuncia_id INTEGER NOT NULL REFERENCES denuncias(id) ON DELETE CASCADE,
      arquivo     TEXT NOT NULL,                 -- nome aleatório no disco
      mime        TEXT NOT NULL,
      bytes       INTEGER NOT NULL
    );
  `);
  return db;
}

// ---------------------------------------------------------------- chave única por denúncia
// 32 símbolos (sem 0/O/1/I) e 16 posições = 80 bits de aleatoriedade.
// Como 256 é múltiplo de 32, "byte & 31" não gera viés.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function gerarChave() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (const b of bytes) s += ALFABETO[b & 31];
  return s; // 16 caracteres
}

function formatarChave(s) {
  return 'AMPA-' + s.match(/.{4}/g).join('-');
}

function normalizarChave(entrada) {
  let s = String(entrada || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('AMPA') && s.length === 20) s = s.slice(4);
  return /^[A-HJ-NP-Z2-9]{16}$/.test(s) ? s : null;
}

const hashChave = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- validação de arquivos
const TIPOS_ARQUIVO = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

// confere se o conteúdo real do arquivo bate com o tipo declarado
function conteudoConfere(caminho, mime) {
  const fd = fs.openSync(caminho, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  switch (mime) {
    case 'image/jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png':  return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':  return buf.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf': return buf.subarray(0, 4).toString('latin1') === '%PDF';
    default: return false;
  }
}

const apagar = (arquivos) =>
  (arquivos || []).forEach((f) => fs.unlink(f.path, () => {}));

// ---------------------------------------------------------------- app
function criarApp(db) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1); // use se estiver atrás de nginx/Render etc.

  // sem logs de acesso de propósito: denúncia anônima não deve gravar IP

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (req, file, cb) =>
        cb(null, crypto.randomBytes(16).toString('hex') + (TIPOS_ARQUIVO[file.mimetype] || '.bin')),
    }),
    limits: { fileSize: MAX_BYTES, files: MAX_ARQUIVOS, fields: 20, fieldSize: 20 * 1024 },
    fileFilter: (req, file, cb) =>
      TIPOS_ARQUIVO[file.mimetype]
        ? cb(null, true)
        : cb(Object.assign(new Error('Tipo de arquivo não permitido. Envie imagens (JPG, PNG, WEBP, GIF) ou PDF.'), { status: 400 })),
  });

  const limiteEnvio = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { erro: 'Muitas denúncias enviadas deste dispositivo. Tente novamente mais tarde.' },
  });
  const limiteConsulta = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { erro: 'Muitas consultas. Aguarde alguns minutos.' },
  });

  // ---------- POST /api/denuncias  (cria uma denúncia e devolve a chave única)
  const inserirDenuncia = db.prepare(
    `INSERT INTO denuncias (key_hash, criada_em, atualizada_em, descricao, local, data_ocorrencia, servico, momento)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const inserirTipo = db.prepare('INSERT INTO denuncia_tipos (denuncia_id, tipo) VALUES (?, ?)');
  const inserirEvidencia = db.prepare('INSERT INTO evidencias (denuncia_id, arquivo, mime, bytes) VALUES (?, ?, ?, ?)');

  app.post('/api/denuncias', limiteEnvio, upload.array('arquivos', MAX_ARQUIVOS), (req, res) => {
    const arquivos = req.files || [];
    const falha = (status, erro) => { apagar(arquivos); return res.status(status).json({ erro }); };

    const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const descricao = texto(req.body.descricao, 5000);
    const local = texto(req.body.local, 200);
    const data = texto(req.body.data, 10);
    const servico = texto(req.body.servico, 60);
    const momento = texto(req.body.momento, 60);
    const tipos = [].concat(req.body.tipos || []).map((t) => texto(t, 80)).filter(Boolean);

    if (data) {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(data) && !Number.isNaN(Date.parse(data));
      if (!ok) return falha(400, 'Data inválida.');
      if (data > new Date().toISOString().slice(0, 10)) return falha(400, 'A data da ocorrência não pode ser futura.');
    }
    if (servico && !SERVICOS.includes(servico)) return falha(400, 'Tipo de serviço inválido.');
    if (momento && !MOMENTOS.includes(momento)) return falha(400, 'Momento do atendimento inválido.');
    if (tipos.some((t) => !TIPOS.includes(t))) return falha(400, 'Tipo de violência inválido.');

    for (const f of arquivos) {
      if (!conteudoConfere(f.path, f.mimetype)) return falha(400, 'Um dos arquivos não corresponde ao tipo informado.');
    }

    // todos os campos são opcionais, mas uma denúncia totalmente vazia não faz sentido
    if (!descricao && !local && !data && !servico && !momento && !tipos.length && !arquivos.length) {
      return falha(400, 'Preencha ao menos um campo para enviar a denúncia.');
    }

    const hoje = new Date().toISOString().slice(0, 10);
    let chave = null;
    let id = null;

    db.exec('BEGIN');
    try {
      // a chave é aleatória; se (quase impossível) colidir, sorteia outra
      for (let tentativa = 0; tentativa < 5 && id === null; tentativa++) {
        const candidata = gerarChave();
        try {
          const r = inserirDenuncia.run(
            hashChave(candidata), hoje, hoje,
            descricao || null, local || null, data || null, servico || null, momento || null
          );
          id = Number(r.lastInsertRowid);
          chave = candidata;
        } catch (e) {
          if (!/UNIQUE/i.test(String(e.message))) throw e;
        }
      }
      if (id === null) throw new Error('Não foi possível gerar uma chave única.');

      [...new Set(tipos)].forEach((t) => inserirTipo.run(id, t));
      arquivos.forEach((f) => inserirEvidencia.run(id, f.filename, f.mimetype, f.size));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      apagar(arquivos);
      console.error('Erro ao salvar denúncia:', e.message);
      return res.status(500).json({ erro: 'Não foi possível registrar a denúncia. Tente novamente.' });
    }

    // a chave só é mostrada agora; não é possível recuperá-la depois
    res.status(201).json({
      protocolo: formatarChave(chave),
      aviso: 'Guarde este protocolo. Ele não pode ser recuperado e é a única forma de acompanhar a denúncia.',
    });
  });

  // ---------- GET /api/denuncias/:chave  (acompanhar andamento)
  const buscarPorHash = db.prepare('SELECT status, criada_em, atualizada_em FROM denuncias WHERE key_hash = ?');

  app.get('/api/denuncias/:chave', limiteConsulta, (req, res) => {
    const chave = normalizarChave(req.params.chave);
    const d = chave && buscarPorHash.get(hashChave(chave));
    if (!d) return res.status(404).json({ erro: 'Protocolo não encontrado.' });
    res.json({ status: d.status, recebida_em: d.criada_em, atualizada_em: d.atualizada_em });
  });

  // ---------- GET /api/estatisticas  (dados agregados para a página de Estatística)
  const contar = (sql) => db.prepare(sql).all().map((r) => ({ nome: r.nome, total: r.total }));

  app.get('/api/estatisticas', (req, res) => {
    res.json({
      total: db.prepare('SELECT COUNT(*) AS n FROM denuncias').get().n,
      por_tipo: contar('SELECT tipo AS nome, COUNT(*) AS total FROM denuncia_tipos GROUP BY tipo ORDER BY total DESC'),
      por_momento: contar("SELECT momento AS nome, COUNT(*) AS total FROM denuncias WHERE momento IS NOT NULL GROUP BY momento ORDER BY total DESC"),
      por_servico: contar("SELECT servico AS nome, COUNT(*) AS total FROM denuncias WHERE servico IS NOT NULL GROUP BY servico ORDER BY total DESC"),
    });
  });

  // ---------- Administração (protegida por ADMIN_TOKEN)
  function exigirAdmin(req, res, next) {
    if (!ADMIN_TOKEN) return res.status(404).json({ erro: 'Não encontrado.' });
    const enviado = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const esperado = Buffer.from(ADMIN_TOKEN);
    if (enviado.length !== esperado.length || !crypto.timingSafeEqual(enviado, esperado)) {
      return res.status(401).json({ erro: 'Não autorizado.' });
    }
    next();
  }

  app.get('/api/admin/denuncias', exigirAdmin, (req, res) => {
    const linhas = db.prepare('SELECT * FROM denuncias ORDER BY id DESC LIMIT 500').all();
    const tipos = db.prepare('SELECT tipo FROM denuncia_tipos WHERE denuncia_id = ?');
    const evid = db.prepare('SELECT id, mime, bytes FROM evidencias WHERE denuncia_id = ?');
    res.json(linhas.map(({ key_hash, ...d }) => ({
      ...d, tipos: tipos.all(d.id).map((t) => t.tipo), evidencias: evid.all(d.id),
    })));
  });

  app.patch('/api/admin/denuncias/:id', exigirAdmin, (req, res) => {
    const { status } = req.body || {};
    if (!STATUS.includes(status)) return res.status(400).json({ erro: `Status deve ser um de: ${STATUS.join(', ')}` });
    const r = db.prepare('UPDATE denuncias SET status = ?, atualizada_em = ? WHERE id = ?')
      .run(status, new Date().toISOString().slice(0, 10), Number(req.params.id));
    if (!r.changes) return res.status(404).json({ erro: 'Denúncia não encontrada.' });
    res.json({ ok: true });
  });

  app.get('/api/admin/evidencias/:id', exigirAdmin, (req, res) => {
    const e = db.prepare('SELECT arquivo, mime FROM evidencias WHERE id = ?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    res.type(e.mime).set('Content-Disposition', 'attachment').sendFile(path.join(UPLOAD_DIR, e.arquivo));
  });

  app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

  // ---------- Front end estático (somente extensões de site; nunca a pasta backend/)
  const EXT_PUBLICAS = /\.(html|css|js|png|jpe?g|svg|webp|ico|woff2?)$/i;
  app.use((req, res, next) => {
    if (req.path === '/' || EXT_PUBLICAS.test(req.path)) return next();
    res.status(404).send('Não encontrado');
  });
  app.use((req, res, next) => {
    if (/^\/(backend|node_modules)(\/|$)/i.test(req.path) || /\/\./.test(req.path)) {
      return res.status(404).send('Não encontrado');
    }
    next();
  });
  app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'ignore' }));

  // ---------- Erros (upload, JSON malformado etc.)
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    apagar(req.files);
    if (err instanceof multer.MulterError) {
      const msgs = {
        LIMIT_FILE_SIZE: 'Arquivo muito grande (máximo 10 MB por arquivo).',
        LIMIT_FILE_COUNT: `Envie no máximo ${MAX_ARQUIVOS} arquivos.`,
        LIMIT_UNEXPECTED_FILE: `Envie no máximo ${MAX_ARQUIVOS} arquivos.`,
      };
      return res.status(400).json({ erro: msgs[err.code] || 'Falha no envio dos arquivos.' });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ erro: status >= 500 ? 'Erro interno.' : err.message });
  });

  return app;
}

// ---------------------------------------------------------------- início
module.exports = { criarApp, abrirBanco, gerarChave, formatarChave, normalizarChave };

if (require.main === module) {
  const db = abrirBanco(path.join(DATA_DIR, 'ampara.db'));
  criarApp(db).listen(PORT, () => {
    console.log(`AMPARA rodando em http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) console.log('Aviso: ADMIN_TOKEN não definido; rotas /api/admin ficam desativadas.');
  });
}
