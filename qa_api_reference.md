# API de QA — WiControl (`client-project-qa`)

**Base URL:** `{SUPABASE_URL}/functions/v1/client-project-qa`

---

## Autenticação

Todas as requisições precisam de **uma** das duas formas de autenticação:

### Opção 1: Sessão Wiflow (acesso interno)
```
Headers obrigatórios:
  apikey: {VITE_SUPABASE_ANON_KEY}
  Authorization: Bearer {VITE_SUPABASE_ANON_KEY}
  Content-Type: application/json
  x-wiflow-session-token: {sessionToken}    ← obtido no login
  x-wiflow-user-id: {userId}                ← obtido no login
```

### Opção 2: Token de acesso do cliente (acesso externo)
```
Headers obrigatórios:
  apikey: {VITE_SUPABASE_ANON_KEY}
  Authorization: Bearer {VITE_SUPABASE_ANON_KEY}
  Content-Type: application/json
  x-client-access-token: {token}            ← obtido via senha do cliente
```

---

## 1. Snapshot (listar QA completo)

> Retorna o projeto, todos os itens de QA, comentários, checklists do cliente e diretório de membros.

```
GET /client-project-qa/snapshot?token={client_share_token}
```

| Parâmetro (query) | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `token` | `string` | ✅ | `client_share_token` do projeto (32-128 chars, hex) |
| `includeMembers` | `"true"\|"false"` | ❌ | Se `false`, não carrega o diretório de membros |

### Response `200`
```json
{
  "project": {
    "id": "uuid",
    "name": "string",
    "client": "string",
    "status": "string",
    "platform": "string | null",
    "template_name": "string | null",
    "designer": "string | null",
    "dev_resp": "string | null",
    "manager": "string | null",
    "seo_resp": "string | null",
    "figma_link": "string | null",
    "docs_link": "string | null",
    "admin_link": "string | null",
    "kickoff_date": "date | null",
    "go_live_date": "date | null",
    "go_live_actual_date": "date | null",
    "go_live_actual_date_change_count": "number | null",
    "contract_hours": "number | null",
    "project_holiday_calendar": "object | null",
    "designer_id": "string | null",
    "dev_resp_id": "string | null",
    "manager_id": "string | null",
    "seo_resp_id": "string | null",
    "wiflow_client_id": "string | null",
    "wiflow_project_id": "string | null",
    "wiflow_projects": "object | null"
  },
  "items": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "device": "Mobile | Desktop | Mob&Desk",
      "location": "string",
      "page_url": "string",
      "description": "string",
      "image_url": "string | null",
      "image_urls": ["string"],
      "status": "Pendente | Em andamento | Validação | Concluído | Cancelado | Info | Layout | Gestão | Cadastro | Plataforma",
      "priority": "Baixa | Média | Alta",
      "responsible_id": "string | null",
      "responsible_name": "string | null",
      "created_by_name": "string",
      "created_by_email": "string | null",
      "status_changed_at": "ISO 8601",
      "created_at": "ISO 8601",
      "updated_at": "ISO 8601"
    }
  ],
  "comments": [
    {
      "id": "uuid",
      "qa_item_id": "uuid",
      "body": "string",
      "author_name": "string",
      "author_email": "string | null",
      "created_at": "ISO 8601"
    }
  ],
  "clientChecklists": [
    {
      "id": "uuid",
      "title": "string",
      "checklist_type": "cliente",
      "items": [
        {
          "id": "uuid",
          "content": "string",
          "is_checked": "boolean",
          "description": "string | null"
        }
      ]
    }
  ],
  "memberDirectory": {
    "dev": [{ "id": "string", "name": "string" }],
    "design": [{ "id": "string", "name": "string" }],
    "manager": [{ "id": "string", "name": "string" }]
  }
}
```

---

## 2. Criar item de QA

```
POST /client-project-qa/item
```

### Request Body
```json
{
  "token": "local-53850937f848150ca1630b1d",
  "item": {
    "device": "Mobile",
    "location": "Home",
    "page_url": "https://example.com/home",
    "description": "Botão de compra desalinhado no mobile",
    "image_url": "https://i.imgur.com/example.png",
    "image_urls": ["https://i.imgur.com/example.png"],
    "status": "Pendente",
    "priority": "Alta",
    "responsible_id": "user-123",
    "responsible_name": "João Silva"
  },
  "author": {
    "name": "Nome do autor",
    "email": "autor@email.com"
  }
}
```

| Campo | Tipo | Obrigatório | Valores |
|---|---|---|---|
| `token` | `string` | ✅ | `client_share_token` do projeto |
| `item.device` | `string` | ✅ | `Mobile`, `Desktop`, `Mob&Desk` |
| `item.location` | `string` | ✅ | `Home`, `Header`, `Footer`, `Minicart`, `Busca`, `Categoria`, `Produto`, `Vitrine`, `Institucional`, `Minha Conta`, `Login`, `Cadastro`, `Checkout`, `Outra` (ou texto livre) |
| `item.page_url` | `string` | ✅ | URL válida (http/https) |
| `item.description` | `string` | ✅ | Descrição do problema |
| `item.image_urls` | `string[]` | ✅ | Pelo menos 1 URL de imagem válida |
| `item.image_url` | `string` | ❌ | Imagem principal (preenchido auto se `image_urls` informado) |
| `item.status` | `string` | ✅ | `Pendente`, `Em andamento`, `Validação`, `Concluído`, `Cancelado`, `Info`, `Layout`, `Gestão`, `Cadastro`, `Plataforma` |
| `item.priority` | `string` | ✅ | `Baixa`, `Média`, `Alta` |
| `item.responsible_id` | `string\|null` | ❌ | ID do responsável (só acesso interno) |
| `item.responsible_name` | `string\|null` | ❌ | Nome do responsável |
| `author.name` | `string` | ❌ | Se omitido, usa dados da sessão Wiflow ou "Cliente" |
| `author.email` | `string` | ❌ | E-mail do autor |

### Response `200`
```json
{
  "item": {
    "id": "uuid",
    "project_id": "uuid",
    "device": "Mobile",
    "location": "Home",
    "page_url": "https://example.com/home",
    "description": "Botão de compra desalinhado no mobile",
    "image_url": "https://i.imgur.com/example.png",
    "image_urls": ["https://i.imgur.com/example.png"],
    "status": "Pendente",
    "priority": "Alta",
    "responsible_id": "user-123",
    "responsible_name": "João Silva",
    "created_by_name": "Nome do autor",
    "created_by_email": "autor@email.com",
    "status_changed_at": "2026-09-11T21:00:00.000Z",
    "created_at": "2026-09-11T21:00:00.000Z",
    "updated_at": "2026-09-11T21:00:00.000Z"
  }
}
```

---

## 3. Atualizar item de QA

```
PUT /client-project-qa/item
```

### Request Body (todos os campos de `item` são opcionais)
```json
{
  "token": "local-53850937f848150ca1630b1d",
  "id": "uuid-do-item",
  "item": {
    "status": "Em andamento",
    "priority": "Média",
    "responsible_id": "user-456",
    "responsible_name": "Maria Souza"
  }
}
```

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `token` | `string` | ✅ | `client_share_token` do projeto |
| `id` | `string` | ✅ | UUID do item de QA |
| `item.*` | parcial | ✅ | Qualquer campo do item (parcial, sem validação de obrigatórios) |

### Response `200`
```json
{
  "item": { /* item completo atualizado, mesma estrutura do criar */ }
}
```

---

## 4. Adicionar comentário

```
POST /client-project-qa/comment
```

### Request Body
```json
{
  "token": "local-53850937f848150ca1630b1d",
  "itemId": "uuid-do-item-qa",
  "body": "Texto do comentário",
  "author": {
    "name": "Nome do autor",
    "email": "autor@email.com"
  }
}
```

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `token` | `string` | ✅ | `client_share_token` do projeto |
| `itemId` | `string` | ✅ | UUID do item de QA |
| `body` | `string` | ✅ | Texto do comentário |
| `author` | `object` | ❌ | Se omitido, usa dados da sessão |

### Response `200`
```json
{
  "comment": {
    "id": "uuid",
    "qa_item_id": "uuid",
    "body": "Texto do comentário",
    "author_name": "Nome do autor",
    "author_email": "autor@email.com",
    "created_at": "2026-09-11T21:00:00.000Z"
  }
}
```

---

## Respostas de erro

Todos os erros retornam:
```json
{ "error": "Mensagem descritiva" }
```

| Status | Significado |
|--------|-----------|
| `400` | Token inválido / dados inválidos / campo obrigatório faltando |
| `401` | Sessão Wiflow inválida ou sem autenticação |
| `404` | Projeto não encontrado / item não encontrado / operação inválida |
| `500` | Erro interno do servidor |

---

## Tokens dos projetos no seed local

| Projeto | `client_share_token` |
|---------|---------------------|
| Casas Bahia B2B | `local-53850937f848150ca1630b1d` |
| Tupan Assentos | `local-fc36dea451acd97cc90c01d1` |
| Calibre | `local-680350e5d9591cae1ae8ad81` |
