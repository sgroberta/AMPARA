'use strict';
// Teste de ponta a ponta: sobe o servidor com banco temporário e exercita a API.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ampara-'));
process.env.ADMIN_TOKEN = 'token-de-teste';
const { criarApp, abrirBanco, gerarChave, normalizarChave, formatarChave } = require('./server');

const db = abrirBanco(path.join(process.env.DATA_DIR, 'teste.db'));
const server = criarApp(db).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const admin = { Authorization: 'Bearer token-de-teste' };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function form(campos, arquivos = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) [].concat(v).forEach((x) => f.append(k, x));
  arquivos.forEach(({ nome, tipo, dados }) => f.append('arquivos', new Blob([dados], { type: tipo }), nome));
  return f;
}

(async () => {
  // chaves: formato e unicidade
  const set = new Set(Array.from({ length: 5000 }, gerarChave));
  assert.equal(set.size, 5000, 'chaves devem ser únicas');
  assert.ok(normalizarChave(formatarChave(gerarChave())));
  assert.equal(normalizarChave('abc'), null);

  // front end é servido; backend/ e dotfiles não
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/denuncia.html')).status, 200);
  assert.equal((await fetch(base + '/backend/server.js')).status, 404);
  assert.equal((await fetch(base + '/backend/data/ampara.db')).status, 404);
  assert.equal((await fetch(base + '/README.md')).status, 404);

  // denúncia vazia é recusada
  let r = await fetch(base + '/api/denuncias', { method: 'POST', body: form({}) });
  assert.equal(r.status, 400);

  // denúncia válida com arquivo
  r = await fetch(base + '/api/denuncias', {
    method: 'POST',
    body: form(
      { descricao: 'Relato de teste <b>x</b>', local: 'Hospital X', data: '2026-01-10',
        servico: 'Público (SUS)', momento: 'Parto', tipos: ['Falta de informação', 'Negativa de acompanhante'] },
      [{ nome: 'meu-nome-real.png', tipo: 'image/png', dados: PNG }]
    ),
  });
  const criada = await r.json();
  assert.equal(r.status, 201, JSON.stringify(criada));
  assert.match(criada.protocolo, /^AMPA(-[A-HJ-NP-Z2-9]{4}){4}$/);

  // segunda denúncia gera chave diferente
  r = await fetch(base + '/api/denuncias', { method: 'POST', body: form({ local: 'UBS', tipos: 'Outro' }) });
  const segunda = await r.json();
  assert.notEqual(segunda.protocolo, criada.protocolo);

  // a chave NÃO fica no banco, só o hash
  const todas = JSON.stringify(db.prepare('SELECT * FROM denuncias').all());
  assert.ok(!todas.includes(criada.protocolo.replace(/-/g, '').slice(4)), 'chave em texto puro não pode estar no banco');

  // arquivo não guarda nome original
  const ev = db.prepare('SELECT arquivo FROM evidencias').get();
  assert.ok(!ev.arquivo.includes('meu-nome-real'));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', ev.arquivo)));

  // consulta por chave (aceita minúsculas e sem hífen)
  r = await fetch(base + '/api/denuncias/' + criada.protocolo.toLowerCase().replace(/-/g, ''));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'recebida');
  assert.equal((await fetch(base + '/api/denuncias/AMPA-AAAA-AAAA-AAAA-AAAA')).status, 404);

  // validações
  r = await fetch(base + '/api/denuncias', { method: 'POST', body: form({ data: '2999-01-01' }) });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/denuncias', { method: 'POST', body: form({ tipos: 'inventado' }) });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/denuncias', {
    method: 'POST', body: form({ local: 'x' }, [{ nome: 'a.png', tipo: 'image/png', dados: Buffer.from('não sou png') }]),
  });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/denuncias', {
    method: 'POST', body: form({ local: 'x' }, [{ nome: 'a.exe', tipo: 'application/x-msdownload', dados: Buffer.from('MZ') }]),
  });
  assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 1, 'uploads rejeitados são apagados');

  // estatísticas
  const est = await (await fetch(base + '/api/estatisticas')).json();
  assert.equal(est.total, 2);
  assert.equal(est.por_tipo.find((t) => t.nome === 'Falta de informação').total, 1);

  // admin
  assert.equal((await fetch(base + '/api/admin/denuncias')).status, 401);
  const lista = await (await fetch(base + '/api/admin/denuncias', { headers: admin })).json();
  assert.equal(lista.length, 2);
  assert.ok(!('key_hash' in lista[0]));
  r = await fetch(base + `/api/admin/denuncias/${lista[1].id}`, {
    method: 'PATCH', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'em_analise' }),
  });
  assert.equal(r.status, 200);
  r = await fetch(base + '/api/denuncias/' + criada.protocolo);
  assert.equal((await r.json()).status, 'em_analise');

  console.log('Todos os testes passaram.');
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
