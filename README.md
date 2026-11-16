# AMPARA
AMPARA é um software de denúncias para apoio a vítimas de violência obstétrica, sendo desenvolvido no IFRS Campus Rio Grande durante o ano de 2026


## Como rodar (front end + back end)

Requer **Node.js 22.13 ou superior**.

```bash
cd backend
npm install
ADMIN_TOKEN=troque-por-um-token-longo npm start
```

Abra http://localhost:3000 — o servidor entrega o site e a API.
Teste automatizado: `npm test` (dentro de `backend/`).

### API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/denuncias` | Cria denúncia (`multipart/form-data`: `descricao`, `local`, `data`, `servico`, `momento`, `tipos[]`, `arquivos[]`). Devolve o **protocolo** único, ex.: `AMPA-7K3M-QX9D-H2TB-WN4R` |
| GET | `/api/denuncias/:protocolo` | Consulta o status (`recebida`, `em_analise`, `encaminhada`, `concluida`) |
| GET | `/api/estatisticas` | Totais agregados (usado pelo gráfico) |
| GET | `/api/admin/denuncias` | Lista denúncias (header `Authorization: Bearer <ADMIN_TOKEN>`) |
| PATCH | `/api/admin/denuncias/:id` | Altera o status: `{"status":"em_analise"}` |
| GET | `/api/admin/evidencias/:id` | Baixa um arquivo anexado |

### Anonimato e segurança
- Cada denúncia recebe uma chave aleatória de 80 bits; só o **hash SHA-256** é guardado, então a chave não pode ser recuperada do banco.
- Não há log de acesso, cookies nem armazenamento de IP; a data de criação é gravada sem hora; arquivos são salvos com nome aleatório (o nome original é descartado).
- Uploads: até 5 arquivos de 10 MB (JPG, PNG, WEBP, GIF ou PDF), com checagem do conteúdo real.
- Limite de envios e de consultas por IP (em memória, sem gravar em disco).
- Em produção, use HTTPS e faça backup da pasta `backend/data/`.
