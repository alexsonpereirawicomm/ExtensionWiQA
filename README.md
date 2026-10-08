# WiControl QA — Extensão do Chrome

Extensão Chrome (Manifest V3) usada pela Wicomm para **registrar itens de QA direto da página que está sendo testada**. Com ela você aponta o elemento com problema, anexa captura anotada e contexto técnico (console, rede, passos e ambiente) e cria o item no projeto do WiControl sem sair do navegador. Também traz o **Fiscal do Pixel**, que compara a página com o design do Figma.

- **Nome no Chrome:** WiControl QA (`manifest.json` versão `1.1.0`, `package.json` `2.0.0`)
- **Chrome mínimo:** 116
- **Sem build:** os arquivos são carregados como estão (JS puro, ES modules, sem dependências npm)
- **Backend:** Supabase. Edge Function `client-project-qa` e `client-access`, do repositório [WiControl](../WiControl/supabase/functions/)

---

## Sumário

1. [O que a extensão faz](#1-o-que-a-extensão-faz)
2. [Instalação](#2-instalação)
3. [Primeiro uso: acessos e conexão](#3-primeiro-uso-acessos-e-conexão)
4. [Criando um item de QA](#4-criando-um-item-de-qa)
5. [Ferramentas em detalhe](#5-ferramentas-em-detalhe)
6. [Aba Itens](#6-aba-itens)
7. [Arquitetura](#7-arquitetura)
8. [Fluxos técnicos](#8-fluxos-técnicos)
9. [Protocolo de mensagens](#9-protocolo-de-mensagens)
10. [Armazenamento local](#10-armazenamento-local)
11. [Backend (Supabase)](#11-backend-supabase)
12. [Privacidade e redação de dados](#12-privacidade-e-redação-de-dados)
13. [Permissões do Chrome](#13-permissões-do-chrome)
14. [Limites e constantes](#14-limites-e-constantes)
15. [Desenvolvimento](#15-desenvolvimento)
16. [Limitações conhecidas e pontos de atenção](#16-limitações-conhecidas-e-pontos-de-atenção)
17. [Documentos relacionados](#17-documentos-relacionados)

---

## 1. O que a extensão faz

| Recurso | Resumo |
|---|---|
| **Painel lateral (Side Panel)** | Interface principal: conexão com o projeto, criação de QA e lista de itens. |
| **Seleção de elemento** | Você clica no elemento com problema. A extensão guarda seletor, atributos, estilos, estado, HTML e uma prévia recortada. **Obrigatória** para criar o item. |
| **Screenshot com recorte e anotação** | Captura a aba, você seleciona a área e desenha (livre, retângulo, seta, 4 cores). Opcional. |
| **Diagnóstico automático** | Enquanto o rascunho está aberto, grava logs do console, erros não tratados, requisições de rede, cliques, envios, mudanças de campo, navegação e dados do ambiente. Os dados sensíveis são redigidos. |
| **Visualização responsiva** | Abre a página numa moldura Desktop (1440×900), Tablet (820×1180) ou Mobile (390×844), ou no tamanho do design. |
| **Fiscal do Pixel** | Inspeciona box model e tipografia, sobrepõe o design do Figma (opacidade, diferença, deslocamento) e captura evidência para o rascunho. |
| **Gravação de tela** | Grava a aba em WebM, com pausa, retomada e cancelamento. *Implementada, mas o botão está oculto no painel por decisão de produto.* |
| **Lista de itens** | Consulta os QAs do projeto, com busca, filtro de status, imagens e comentários. Itens em **Validação** podem ser concluídos pela lista; itens **Info** abrem a conversa completa de comentários. |
| **Atalhos globais** | Clique no ícone ou `Alt+Shift+Q` abre o painel direto. `Alt+Shift+S` faz uma captura rápida da aba atual (abre o painel junto). No painel, `Ctrl+Enter` avança a etapa ou cria o item. Os atalhos podem ser trocados em `chrome://extensions/shortcuts`. |
| **Menu de contexto** | Botão direito na página → **Reportar este elemento no WiControl QA**: abre o painel e seleciona o elemento clicado (se a extensão já estava ativa na página; senão, entra no modo de seleção por clique). |
| **Contador no ícone** | O ícone mostra quantos QAs abertos existem para a página da aba (mesmo host sem `www` e caminho, ignorando query e hash). O número vem da última listagem de itens e é atualizado ao criar um item. |
| **Modo escuro e guia** | O painel segue o tema do sistema (claro/escuro). No primeiro uso, um guia de 3 dicas apresenta as etapas, a seleção de elemento e os atalhos (Esc ou **Pular** fecha; não reaparece). |

---

## 2. Instalação

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**, no canto superior direito.
3. Clique em **Carregar sem compactação** e escolha a pasta `extension-base/`.
4. Fixe o ícone do WiControl QA na barra.

Para atualizar depois de mudar o código, clique em **recarregar** (↻) no card da extensão. Se o painel avisar "Recarregue o WiControl QA em chrome://extensions", é porque o background ficou desatualizado em relação ao painel. Veja [Versão de protocolo](#versão-de-protocolo).

---

## 3. Primeiro uso: acessos e conexão

### 3.1 Liberar acessos

| Acesso | Quando é concedido | Para quê |
|---|---|---|
| Domínio do Supabase (`https://gfzsahqvxloggzlvrpxr.supabase.co/*`) | Na instalação (`host_permissions`) | Chamar a API e subir mídia. |
| Todas as páginas (`<all_urls>`) | Pedido no primeiro screenshot, seleção de elemento ou Fiscal do Pixel (`optional_host_permissions`) | `captureVisibleTab` só funciona com `<all_urls>`. O acesso a um site só não basta. |

Se você recusar um pedido, a extensão abre a página **Liberar acessos** (`permissions/permissions.html`), que mostra o estado de cada acesso e o passo a passo. Ela também pode ser aberta pelo ícone de escudo no cabeçalho do painel.

### 3.2 Conectar ao projeto

A **URL do Supabase** e a **anon key** são fixas no código, em [`shared/config.js`](shared/config.js), e apontam para o Supabase de produção do WiControl. As duas são públicas por natureza: o acesso é controlado pela Edge Function, não por elas. A extensão **nunca** usa a `service_role`.

Ao abrir o painel sem configuração, aparece a tela **Conecte seu projeto**, só com:

| Campo | O que informar |
|---|---|
| **Token de compartilhamento do projeto** | O `client_share_token` do projeto no WiControl. |
| **Senha de acesso (convidado)** | Senha de acesso do cliente ao projeto. |

O que acontece ao clicar em **Validar e conectar**:

1. O background junta token e senha com a URL e a chave fixas (`withFixedConnection`).
2. Troca a senha por um **token de sessão de convidado** em `POST /functions/v1/client-access/verify`. O token vale **12 horas**.
3. Valida tudo chamando `GET /client-project-qa/snapshot`. Se vier um projeto, a configuração é salva em `chrome.storage.local`.

Configurações salvas com outra URL do Supabase (ex.: do ambiente local) são descartadas automaticamente, e o painel pede uma nova conexão. Para trocar de projeto ou de credencial, use a engrenagem no cabeçalho.

**Sessão expirada:** quando o token passa de 12h, ou quando qualquer chamada responde 401, o painel volta para a conexão com "Sua sessão expirou. Informe a senha novamente para continuar." O token salvo é descartado.

> **Modo WiFlow:** o código também aceita autenticação por sessão interna do WiFlow (`x-wiflow-session-token` + `x-wiflow-user-id`). Esse modo libera a atribuição de responsável. Hoje **não há como escolhê-lo pela interface**: só funciona se vier numa configuração já salva.

---

## 4. Criando um item de QA

A aba **Novo QA** é um slider de três etapas (Local → Descrição → Detalhes), lado a lado. Um stepper acima mostra a etapa atual, as concluídas (✓) e as próximas; a barra inferior tem **Voltar**, a pendência da etapa e **Continuar** (na última, **Criar item de QA**). Avançar exige a etapa atual completa: com pendência, **Continuar** leva até o campo que falta. Voltar é sempre livre, pelo stepper, pelo **Voltar** ou pelos links **Editar** do resumo. `Ctrl+Enter` continua (ou cria, na última etapa). Ao reabrir o painel, o slider abre na primeira etapa pendente; depois de criar o item, volta para a etapa 1. Para desistir do registro, a **lixeira** na barra inferior (aparece quando há algo preenchido) pede confirmação e descarta tudo: elemento, anexos locais, descrição e diagnóstico. Autor, preferências do projeto e o Local sugerido pela URL continuam. O rascunho é salvo sozinho, com debounce de 350 ms, e sobrevive a fechar e reabrir o painel.

### Card da página

Mostra domínio, título e URL da aba ativa, com o botão **Copiar URL**. A URL preenche o campo *URL da página* e, com o título, define o *Local* sozinho a partir de regras (ex.: `checkout` → Checkout), com a dica "Sugerido pela URL". A sugestão acompanha a troca de aba até você digitar outro valor. O botão **Fiscal do Pixel** também fica aqui (veja a [seção 5.4](#54-fiscal-do-pixel)).

### Etapa 1 de 3 — Onde está o problema?

1. **Visualização (opcional):** Tela inteira, Desktop, Tablet ou Mobile. Desktop e Mobile ajustam o campo *Dispositivo* sozinhos.
2. **Selecionar elemento (obrigatório):** clique em **Selecionar elemento** e depois no elemento da página. Esc cancela. Uma prévia aparece no painel e é **anexada sozinha** como `elemento-*.webp` (selo "Anexada ao relato"). **Anotar** abre um editor com retângulo, seta, caneta, 3 cores e desfazer; a versão anotada substitui a prévia anexada; **Alterar elemento** troca a seleção e substitui a imagem. Selecionar o elemento avança o slider para a etapa 2.
3. **Adicionar screenshot (opcional):** selecione a área na página, anote e clique em **Concluir**.
4. **Arquivos capturados:** cada mídia mostra prévia, tamanho e status:

   | Status | Significado |
   |---|---|
   | Pronto para enviar | Mídia salva localmente, aguardando o envio. |
   | Enviando ao Supabase… | Upload em andamento. |
   | Enviado · WebP | Upload concluído. |
   | Envio pendente — tentará ao criar o item | O upload falhou e será tentado de novo no envio. |
   | Falha no arquivo | A mídia não pôde ser processada. |

   As imagens começam a subir **logo após a captura** (pré-upload). Assim, criar o item só precisa vincular os anexos.

### Etapa 2 de 3 — O que está errado?

Se a listagem de itens tem QAs **abertos na mesma página**, um aviso no topo mostra até 3 deles (status e erro) e o link **Ver na lista de itens**, que abre a aba Itens filtrada pelo caminho da página.

**Tipo do problema (opcional):** Layout, Funcional, Conteúdo, Responsivo ou Outros. O tipo escolhido mostra um exemplo de preenchimento; ele não altera a descrição nem vai para o item (só fica salvo no rascunho).

A descrição é digitada em **dois campos obrigatórios**: *Qual erro acontece?* e *O que era esperado?* (até 2400 caracteres cada). No envio eles viram um texto só no campo descrição do item:

```
O que acontece:
<erro>

O que deveria acontecer:
<esperado>
```

Com o tipo **Outros** (dúvidas, sugestões, casos que não são um erro), os dois campos dão lugar a um campo livre *Descreva o caso* (obrigatório, até 5000 caracteres), enviado como está. Ao trocar de tipo, o texto já escrito passa para o outro formato. Rascunhos antigos são separados de volta nos dois campos pelos títulos.

### Etapa 3 de 3 — Detalhes do item

No topo, um resumo mostra o elemento, o número de anexos e o erro descrito, com links para voltar e editar.

| Campo | Regras |
|---|---|
| Dispositivo | `Desktop`, `Mobile` ou `Mob&Desk`. O valor do último QA criado no projeto vira o padrão do próximo (a visualização Desktop/Mobile aberta tem prioridade). |
| Local | Obrigatório, até 100 caracteres. Sugestões: Home, Header, Checkout, Outra etc. |
| Prioridade | `Baixa`, `Média` ou `Alta`. Também lembra o último valor usado no projeto. |
| Status | `Pendente`, `Em andamento`, `Validação`, `Concluído`, `Cancelado`, `Info`, `Layout`, `Gestão`, `Cadastro`, `Plataforma`. |
| Responsável | Só no modo WiFlow. Nas sessões de convidado fica desabilitado. |
| Autor e página | URL da página (obrigatória, http/https), nome e e-mail do autor (opcionais; ficam salvos para os próximos itens). |

### Diagnóstico técnico ("Para desenvolvedores")

Seção recolhível com contadores de **Console**, **Rede**, **Passos** e **Elemento**, o selo *Monitorando/Pausado* e o alerta "N falhas detectadas" (erros de console somados a requisições com status ≥ 400). **Limpar diagnóstico** zera tudo, mas mantém o elemento selecionado.

### Envio

**Reenvio automático:** se o envio falhar por rede, tempo esgotado ou erro do servidor (5xx, 408, 429), o painel tenta de novo após 10 s, 30 s, 1 min, 2 min e 5 min, com a contagem na barra inferior e o botão **Tentar agora**. Voltar a ficar online dispara a tentativa na hora, e a fila sobrevive a fechar o painel. O `client_request_id` (draftId) garante que o item não duplica. Erros de validação, sessão e outros 4xx não são repetidos.

A barra inferior mostra o que falta preencher, nesta ordem: conexão → elemento → descrição → dispositivo → local → URL → prioridade → status → e-mail. Com tudo válido, **Criar item** (timeout de 60 s):

1. termina de subir as mídias pendentes;
2. envia o diagnóstico (`POST /diagnostic`);
3. cria o item (`POST /item`) com os IDs dos anexos e do diagnóstico;
4. limpa o rascunho, as mídias locais e o diagnóstico, e começa um novo rascunho.

O `draftId` do rascunho vai como `client_request_id` e `Idempotency-Key`. Por isso, reenviar o mesmo rascunho depois de uma falha de rede não duplica o item.

---

## 5. Ferramentas em detalhe

### 5.1 Seleção de elemento

- Ao passar o mouse, o elemento ganha um contorno rosa e o rótulo `seletor · L × A`. O clique escolhe e Esc cancela.
- Funciona dentro da visualização responsiva, desde que a moldura seja da mesma origem.
- **O que é guardado** (`describeElement` em `content/injected.js`):
  - `selector` estável, `tag`, `role`, `accessible_name`;
  - atributos da lista permitida: `id`, `role`, `name`, `type`, `aria-label`, `aria-expanded`, `aria-checked`, `data-testid`, `data-test`, `data-cy`;
  - retângulo, viewport;
  - estilos computados: display, posição, z-index, overflow, cores, fonte, margin, padding, border;
  - estado: visível, desabilitado, com foco;
  - `outerHTML`, até 4096 caracteres.
- **Prioridade do seletor:**
  1. `data-testid`/`data-test`/`data-cy` único;
  2. `#id`, a menos que pareça gerado (4+ dígitos ou hash/uuid);
  3. caminho de até 6 níveis, com até 2 classes por nível (ignorando `active`, `hover`, `css-*`, `sc-*` etc.) e `:nth-of-type`.
- **Prévia:** depois do clique, o background captura a aba, recorta o elemento com 8 px de folga, limita a 900 px e salva em WebP. Ela não vai no diagnóstico; entra no rascunho como imagem anexada (`elemento-*.webp`).

### 5.2 Screenshot, recorte e anotação

1. O background captura a parte visível da aba (`captureVisibleTab`, PNG).
2. Na página, a imagem aparece escurecida. Arraste para selecionar; seleções menores que 12×12 px são descartadas. Esc cancela.
3. O editor de anotação abre com:
   - **Ferramentas:** Livre, Retângulo, Seta;
   - **Cores:** Rosa Wicomm `#ff004b`, Azul `#0074ff`, Verde `#16a062`, Amarelo `#ffbf00`;
   - traço de 4 px. **Não há desfazer nem texto.**
4. **Concluir** envia a imagem ao background, que a reduz para no máximo **2560 px** no maior lado, converte para **WebP (qualidade 0,82)**, guarda no IndexedDB e inicia o pré-upload.

Toda a interface injetada na página fica num **Shadow DOM fechado**, para não herdar nem afetar o CSS do site.

### 5.3 Visualização responsiva

| Preset | Tamanho |
|---|---|
| Tela inteira | Sem moldura |
| Desktop | 1440 × 900 |
| Tablet | 820 × 1180 |
| Mobile | 390 × 844 |
| Design | Tamanho do design carregado no Fiscal do Pixel (largura 240–2560, altura 200–2560) |

A página é **recarregada dentro de um iframe** (`src = location.href`), escalada para caber na tela (nunca acima de 1×), com barra "Sair da visualização". Esc também fecha. O preset escolhido vai junto com o diagnóstico (`device_context.emulated_viewport`).

Por causa do iframe, a visualização tem estas limitações:

- formulários não salvos e POSTs se perdem;
- sites com `X-Frame-Options` ou `frame-ancestors` não abrem (após 12 s o carregamento é dado como concluído);
- a inspeção só funciona na mesma origem.

### 5.4 Fiscal do Pixel

Ferramenta de **só visualização**: não altera a página nem o item, exceto quando você captura evidência. Abre pelo botão no card da página e mostra uma barra flutuante compacta na própria aba: **Inspecionar**, **Comparar com design**, **Capturar**, ajuda (?), mover a barra e sair. Mensagens de status aparecem como um aviso acima da barra e somem sozinhas.

**Inspeção** (ligada por padrão):

- O hover mostra o box model nas cores do DevTools: margem laranja, borda amarela, padding verde, conteúdo azul.
- No hover, uma ficha resumida mostra tag, dimensões, fonte (família · tamanho · peso), cor e fundo.
- O clique **fixa** o elemento e abre a ficha completa — dimensões, margem, padding, borda, raio, fonte, tamanho, peso (com nome), altura de linha (px e razão), espaçamento entre letras, cor e fundo (hex + alpha) — com **Copiar specs**.

**Design de referência:**

- Carrega por botão, **Ctrl+V** ou arrastar e soltar. Aceita PNG, JPG, WebP, GIF e AVIF, até 40 MB.
- A escala do export (1x–4x) é detectada pela largura (ex.: 750 px → 2x; 1170 px → 3x) e pode ser ajustada à mão.
- Ao carregar, a tela assume a largura do design, em px CSS (largura ÷ escala). Em designs de página inteira a altura acompanha a rolagem.
- Com um design carregado, uma segunda linha aparece acima da barra: ocultar/mostrar, opacidade (padrão 50%), modo **Diferença** e escala. O deslocamento X/Y só aparece quando é diferente de zero. Centralizar, Zerar posição, Trocar design e Remover design ficam no menu **⋯**.
- O design é desenhado num `<canvas>`, o que evita a CSP `img-src` do site e permite `mix-blend-mode`.

**Capturar evidência (P):** esconde a barra, captura a aba (com o design sobreposto e o destaque fixado) e anexa ao rascunho como `pixel-perfect-*.webp`.

**Atalhos de teclado:**

| Tecla | Ação |
|---|---|
| Clique | Fixar / soltar elemento |
| Setas | Mover o design 1 px (Shift: 10 px) |
| `1`–`9` / `0` | Opacidade 10–90% / 100% |
| `-` / `+` | Opacidade −10% / +10% |
| `H` | Ocultar/mostrar design |
| `D` | Modo diferença |
| `C` | Centralizar |
| `R` | Zerar deslocamento |
| `I` | Ligar/desligar inspeção |
| `P` | Capturar evidência |
| `?` | Ajuda |
| `Esc` | Fecha a ajuda → solta o elemento → sai do Fiscal |

Os atalhos são ignorados com Ctrl/Cmd/Alt pressionado ou com o foco em campos editáveis.

### 5.5 Gravação de tela (oculta)

O fluxo continua implementado, embora o botão `btnVideo` esteja com `hidden` no painel:

1. contagem regressiva 3-2-1 na página (850 ms por número);
2. o background obtém o `streamId` com `chrome.tabCapture` e abre o **documento offscreen**;
3. o offscreen grava com `MediaRecorder` em **WebM**, na ordem de preferência `vp9,opus` → `vp9` → `vp8,opus` → `vp8` → `webm`, em fatias de 1 s. **Sem áudio** por padrão;
4. a página mostra uma barra "Gravando aba" com cronômetro e botão **Parar**. O painel tem Pausar, Retomar, Parar e Cancelar;
5. o vídeo vai para o IndexedDB e aparece em *Arquivos capturados*.

`tabCapture` só funciona depois que a extensão é acionada na aba pelo ícone da barra. Sem isso, o erro `TAB_CAPTURE_NOT_INVOKED` explica o que fazer.

### 5.6 Diagnóstico automático

Começa sozinho quando o painel abre um rascunho numa página http(s). Fica ligado ao `draftId`: trocar de rascunho descarta o diagnóstico anterior.

| Tipo | Origem | O que registra |
|---|---|---|
| `console` | `observer.js` (patch de `console.*`) | Nível e argumentos serializados de `debug/info/log/warn/error`. |
| `console` (`uncaught`, `unhandledrejection`) | Listeners `error`/`unhandledrejection` | Mensagem, stack, arquivo, linha e coluna. |
| `network` (`fetch`/`xhr`) | Patch de `fetch` e `XMLHttpRequest` | Método, URL redigida, status, `ok`, duração e content-type. **Sem headers nem corpo.** |
| `network` (`browser`) | `chrome.webRequest` no background | Demais recursos (documento, script, imagem, CSS etc.), com status, duração e erro. |
| `step` | Listeners de `click`, `submit`, `change`, `pushState`/`replaceState`/`popstate`/`hashchange` | Papel e rótulo do alvo. **Valores digitados nunca são capturados** (`value_captured: false`). |
| `environment` | Uma vez por página | URL, título, viewport, tela, DPR, orientação, toque, idioma, online, user agent, fuso. |
| `element` | Seleção de elemento | Descritor do elemento (até 10 por rascunho). |

Depois que a visualização responsiva é aberta, o diagnóstico também roda nos iframes (`frame-relay.js` repassa os eventos ao background).

---

## 6. Aba Itens

- Lista os itens do projeto (`WI_QA_LIST_ITEMS` → `GET /snapshot?includeMembers=false`). O cache dura **5 minutos**, porque as URLs assinadas das imagens valem 10 minutos. O botão de atualizar força a recarga.
- **Busca** sem acento por descrição, local, autor e URL.
- **Filtro de status:** *Em aberto* (padrão; esconde Concluído e Cancelado), *Todos* ou um status específico. O selo da aba mostra o total de itens em aberto.
- Cada card mostra status, prioridade, data relativa, descrição (3 linhas), dispositivo · local, autor e o número de imagens e de comentários. Ao expandir, aparecem miniaturas (abrem no visualizador; Ctrl/Cmd/clique do meio abre em nova aba), o responsável, os comentários e os botões **Abrir página** e **Copiar ID**.
- **Itens em Validação:** na lista aparecem normalmente, na ordem de sempre. Um aviso no topo conta quantos são; ao tocar, a lista mostra só esses, com o selo **Aguardando validação** e destaque roxo (tocar de novo volta para "em aberto"). Além da página e das imagens, o card tem **Marcar como concluído**. O primeiro clique vira **Confirmar conclusão** (vale por 5 s); o segundo envia `WI_QA_COMPLETE_ITEM` → `PUT /item` com `{ status: "Concluído" }`. Convidados e usuários WiFlow podem concluir. O item sai do filtro *Em aberto* e deixa de contar no ícone.
- **Imagens quebradas:** miniatura que falha ao carregar (URL expirada ou arquivo removido) some do card, junto com a contagem; não reaparece ao reexpandir.
- **Itens Info:** os comentários não aparecem no card; **Ver comentários (N)** abre a conversa completa, em ordem cronológica, com autor, data e hora.
- Fora isso, a aba é somente leitura: não é possível editar campos nem comentar pela extensão.

---

## 7. Arquitetura

```
┌───────────────────────── Chrome ──────────────────────────┐
│                                                           │
│  ícone / atalhos   sidepanel/            permissions/     │
│  (abre o painel)   (UI principal)        (guia de acesso) │
│      │                  │                                 │
│      └──── chrome.runtime.sendMessage ───┐                │
│                                          ▼                │
│                 background/service-worker.js              │
│      (orquestra captura, diagnóstico, upload e API)       │
│        │               │                  │               │
│        ▼               ▼                  ▼               │
│  offscreen/      chrome.scripting   shared/api-client.js ─┼──► Supabase
│  (MediaRecorder)  executeScript          (fetch)          │    Edge Functions
│        │               │                                  │    + Storage
│        ▼               ▼                                  │
│   IndexedDB     Página testada                            │
│  (blobs 24h)    ├─ content/observer.js   (world MAIN)     │
│                 ├─ content/injected.js   (world ISOLATED) │
│                 └─ content/frame-relay.js (iframes)       │
└───────────────────────────────────────────────────────────┘
```

### Estrutura de pastas

| Caminho | Papel |
|---|---|
| `manifest.json` | MV3, service worker `background/service-worker.js` (module), side panel (aberto direto pelo ícone), `commands` (atalhos) e permissões. **Sem `content_scripts`**: toda injeção é sob demanda. |
| `background/service-worker.js` | Orquestrador central: roteia mensagens, injeta scripts, captura imagem, otimiza para WebP, controla gravação, guarda o diagnóstico, faz upload e chama a API. |
| `sidepanel/` | Interface principal (conexão, Novo QA, Itens, visualizador de mídia). |
| `permissions/` | Página "Liberar acessos", com cards para o domínio do Supabase e para as páginas. Aceita `?focus=site\|pages&origin=…`. |
| `offscreen/` | Documento offscreen para `getUserMedia` + `MediaRecorder` (service workers não têm acesso a mídia). |
| `content/observer.js` | Roda no **world MAIN** da página. Faz patch de console, fetch, XHR e history e emite eventos via `postMessage`. |
| `content/injected.js` | Roda no **world ISOLATED**. Contém a ponte observer → background e toda a UI na página: recorte, anotação, contagem, barra de gravação, seleção de elemento, visualização responsiva e Fiscal do Pixel. |
| `content/frame-relay.js` | Repassa eventos do observer em iframes (só frames não-top). |
| `shared/config.js` | URL e anon key fixas do Supabase de produção. |
| `shared/api-client.js` | Cliente HTTP da Edge Function, normalização e validação da config, upload para URL assinada. |
| `shared/contracts.js` | Chaves de storage, enums (dispositivo, prioridade, status), estado do gravador e validação do rascunho. |
| `shared/media-store.js` | Acesso ao IndexedDB `wicontrol-qa-media`. |
| `supabase/` | **Rascunho modular antigo** da Edge Function e migration. **Não é a versão em uso.** Veja a [seção 11](#11-backend-supabase). |
| `scripts/validate-extension.mjs` | Validação estática do manifesto (inclui ícones em PNG). |
| `scripts/build-icons.mjs` | Gera `assets/icon-{16,32,48,128}.png` a partir de `assets/icon.svg` com o Chrome headless. |
| `tests/contracts.test.mjs` | Testes de `api-client` e `contracts` (node:test). |
| `assets/logo.svg` | Logo Wicomm (branco), usado no cabeçalho do painel. |
| `assets/icon.svg` / `icon-*.png` | Ícone da extensão: `logo.svg` sobre fundo escuro. O Chrome só aceita PNG em `manifest.icons`; rode `node scripts/build-icons.mjs` após mudar o SVG. |

### Como os scripts entram na página

O background chama `ensureContentScript(tabId)` antes de qualquer ação na página:

1. injeta `observer.js` no world `MAIN`, só no frame principal;
2. manda `WI_QA_PING`. Se ninguém responder, injeta `injected.js` no world isolado.

Quando a visualização responsiva abre, `ensureFrameDiagnostics` injeta `observer.js` e `frame-relay.js` com `allFrames: true`. Todos os scripts têm guarda contra injeção dupla (`__wiqaObserverLoaded`, `__wiqaContentV2Loaded`, `__wiqaFrameRelayLoaded`). Só páginas `http://` e `https://` são aceitas. Em outras (`chrome://`, PDF etc.) o erro é `TAB_NOT_INJECTABLE`.

---

## 8. Fluxos técnicos

### 8.1 Upload de mídia (URL assinada)

```
service worker                     Edge Function                Storage (qa-media)
     │  POST /media/init  ───────────►  valida tipo/tamanho
     │  (kind, mime, size, Idempotency-Key)  cria qa_media
     │  ◄─────────────── media_id + upload_url assinada
     │  PUT upload_url (blob) ───────────────────────────────────►  grava objeto
     │  POST /media/complete ────────►  confere objeto, status=ready
     │  ◄─────────────── status
```

- `ensureMediaUploaded` compartilha a mesma promessa entre o pré-upload e o envio do item, para que a mesma imagem não suba duas vezes.
- `assertSignedUploadUrl` só aceita URLs do host do Supabase configurado. Exceção para o ambiente local: a URL `http://kong:8000/...` é reescrita para a origem configurada, mantendo o caminho assinado.
- Se o upload falhar, a mídia fica com status `local` e é tentada de novo ao criar o item.

### 8.2 Criação do item

`createQaItem` no service worker:

1. junta o rascunho salvo com os campos atuais e valida (`validateDraft` com `requireElement: true`; imagem não é obrigatória);
2. sobe todas as mídias pendentes;
3. se houver diagnóstico do mesmo `draftId`, monta o payload (`schema_version: 1`), limitado a **900 KB** (descarta console, depois rede, depois passos, a partir dos mais antigos), e faz `POST /diagnostic`;
4. `POST /item` com `attachment_ids` e `diagnostic_session_ids`. As imagens entram só como anexos (`qa_item_attachments`); URLs assinadas não são gravadas em `image_urls`, porque expiram;
5. em caso de sucesso, guarda `wiqaLastItem`, apaga blobs, rascunho e diagnóstico e emite `WI_QA_ITEM_CREATED`.

### 8.3 Gravação

`WI_QA_VIDEO_START`:

1. confere se não há gravação ativa (`RECORDER_BUSY`) e testa `tabCapture` **antes** da contagem;
2. `showCountdown` na página;
3. cria o offscreen e pede um novo `streamId` (ele expira em segundos);
4. `START_TAB_RECORDING`;
5. o offscreen emite `RECORDER_STARTED`, `RECORDER_PROGRESS` (a cada 1 s), `RECORDER_PAUSED`/`RESUMED`, `RECORDER_STOPPED`, `RECORDER_CANCELLED` ou `RECORDER_ERROR`.

Se o navegador reiniciar no meio de uma gravação, `reconcileRecorderState` marca o erro `RECORDER_CONTEXT_LOST`.

### 8.4 Inicialização do service worker

Em `onInstalled`/`onStartup`:

- liga `openPanelOnActionClick`;
- restringe `storage.local` a `TRUSTED_CONTEXTS`, para que content scripts não leiam credenciais;
- apaga blobs expirados (24h) e restos do ditado por voz, recurso que foi removido;
- reconcilia o estado do gravador.

---

## 9. Protocolo de mensagens

Todas as mensagens passam por `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` com um campo `target` (`background`, `content`, `offscreen` ou `ui`). O painel também copia os campos de `payload` para o nível de cima, por compatibilidade.

### Para o background (`target: 'background'`)

| Tipo | Quem envia | Função |
|---|---|---|
| `WI_QA_GET_CONTEXT` | painel | Config pública, projeto, rascunho, mídia, gravador, aba, diagnóstico, viewport e `protocolVersion`. |
| `WI_QA_VALIDATE_CONFIG` | painel | Troca a senha por token, valida o snapshot e salva a config. |
| `WI_QA_DISCONNECT` | — | Remove config, projeto e rascunho. |
| `WI_QA_SAVE_DRAFT` | — | Normaliza e salva o rascunho. |
| `WI_QA_DRAFT_RESET` | painel | Apaga rascunho e mídias e inicia diagnóstico para `nextDraftId`. |
| `WI_QA_CAPTURE_SCREENSHOT` (legado `takeScreenshot`) | painel | Captura a aba e abre o recorte. |
| `WI_QA_SAVE_SCREENSHOT` (legado `saveCropResult`) | página, painel | Otimiza, guarda e faz o pré-upload da imagem. |
| `WI_QA_SELECT_ELEMENT` | painel | Seleção de elemento + prévia. |
| `WI_QA_START_DIAGNOSTICS` / `WI_QA_CLEAR_DIAGNOSTICS` | painel | Inicia ou limpa o diagnóstico (mantém o elemento). |
| `WI_QA_DIAGNOSTIC_EVENT` | página, iframes | Adiciona um evento ao pacote da aba. |
| `WI_QA_VIDEO_START` / `_STOP` / `_PAUSE` / `_RESUME` / `_CANCEL` | painel, página | Controle da gravação. |
| `WI_QA_MEDIA_REMOVE` | painel | Remove uma mídia (blob + metadados). |
| `WI_QA_CREATE_ITEM` | painel | Fluxo completo de criação. |
| `WI_QA_LIST_ITEMS` | painel | Itens + comentários do snapshot. |
| `WI_QA_COMPLETE_ITEM` | painel | Conclui um item em Validação (`PUT /item`, só `status`). |
| `WI_QA_SET_VIEWPORT` | painel, página | Aplica um preset de visualização. |
| `WI_QA_VIEWPORT_CLOSED` / `WI_QA_VIEWPORT_FRAME_READY` | página | Moldura fechada pela página / iframe carregado. |
| `WI_QA_PIXEL_INSPECTOR_START` / `_STOP` / `_CLOSED` | painel, página | Abre ou fecha o Fiscal do Pixel. |
| `WI_QA_PIXEL_CAPTURE` | página | Captura a evidência do Fiscal. |
| `RECORDER_*` | offscreen | Eventos do gravador. |
| `saveRecording` | — | Legado: grava um vídeo recebido como dataURL. |

### Para a página (`target: 'content'`)

`WI_QA_PING`, `WI_QA_SET_DIAGNOSTIC_SESSION`, `initCrop`, `showCountdown`, `showRecordingBar`, `hideRecordingBar`, `WI_QA_SELECT_ELEMENT`, `WI_QA_VIEWPORT_SHOW`, `WI_QA_VIEWPORT_HIDE`, `WI_QA_PIXEL_INSPECTOR_SHOW`, `WI_QA_PIXEL_INSPECTOR_HIDE`.

### Para o offscreen (`target: 'offscreen'`)

`START_TAB_RECORDING`, `PAUSE_RECORDING`, `RESUME_RECORDING`, `STOP_RECORDING`, `CANCEL_RECORDING`, `GET_RECORDER_STATE`, `DELETE_RECORDING`.

### Difusão para as interfaces (`target: 'ui'`)

`WI_QA_CONTEXT_UPDATED`, `WI_QA_MEDIA_UPDATED`, `WI_QA_RECORDER_STATE`, `WI_QA_DIAGNOSTICS_UPDATED`, `WI_QA_ITEM_CREATED`, `WI_QA_SESSION_EXPIRED`, `WI_QA_VIEWPORT_STATE`, `WI_QA_PIXEL_INSPECTOR_STATE`, `WI_QA_PIXEL_EVIDENCE_ADDED`, `WI_QA_ERROR`.

### Erros

As respostas seguem `{ success: false, error: { message, code, status, retryable, requestId, details } }`. Códigos comuns:

| Código | Situação |
|---|---|
| `PAGE_ACCESS_REQUIRED` | Falta `<all_urls>`. |
| `TAB_CAPTURE_NOT_INVOKED` | Gravação sem acionar o ícone na aba. |
| `TAB_NOT_INJECTABLE` | Página não http(s). |
| `SESSION_EXPIRED` | Token de convidado vencido ou 401. |
| `VALIDATION_ERROR` | Campos do rascunho inválidos (`details` traz o campo). |
| `RECORDER_BUSY`, `RECORDER_SESSION_MISMATCH`, `EMPTY_RECORDING`, `RECORDER_CONTEXT_LOST` | Gravação. |
| `SIGNED_UPLOAD_FAILED`, `MEDIA_TOO_LARGE`, `UPLOAD_URL_HOST_MISMATCH` | Upload. |
| `NETWORK_ERROR`, `REQUEST_TIMEOUT` | Conexão com o Supabase (timeout padrão de 30 s). |
| `UNKNOWN_MESSAGE` | Background desatualizado; o painel recarrega a extensão. |

### Versão de protocolo

O service worker expõe `BACKGROUND_PROTOCOL_VERSION = 9`, e o painel exige `REQUIRED_BACKGROUND_PROTOCOL = 9`. Se o painel encontrar uma versão menor, chama `chrome.runtime.reload()`, no máximo uma vez a cada 30 s. **Ao criar mensagens novas, aumente os dois valores juntos.**

---

## 10. Armazenamento local

### `chrome.storage.local` (restrito a contextos confiáveis)

| Chave | Conteúdo |
|---|---|
| `wiqaConfig` | URL, chave pública, token do projeto, modo de auth, token de convidado e expiração, autor. |
| `wiqaProject` | Projeto retornado pelo snapshot. |
| `wiqaDraft` | Rascunho atual (campos do item, autor, `clientRequestId`). |
| `wiqaMedia` | Metadados das mídias (status, `remoteMediaId`, tamanho etc.). Os blobs ficam no IndexedDB. |
| `wiqaRecorderState` | Estado do gravador (`idle`, `countdown`, `recording`, `paused`, `stopping`, `done`, `cancelled`, `error`). |
| `wiqaLastItem` | Último item criado. |
| `capturedMedia`, `isRecording`, `recordingStart` | Legado, mantido por compatibilidade. |
| `wiqaProtocolReloadAt` | Trava do auto-reload por versão de protocolo. |

### `chrome.storage.session` (some ao fechar o navegador)

| Chave | Conteúdo |
|---|---|
| `wiqaDiagnostics` | Pacote de diagnóstico por aba (`tabId` → console, rede, passos, elementos, ambiente, descartes). |
| `wiqaViewports` | Preset de visualização por aba. Volta para `full` quando a aba fecha. |

### IndexedDB `wicontrol-qa-media` / store `recordings`

Blobs de imagens e vídeos, com chave `recordingId` e índices `expiresAt` e `sessionId`. **Expiram em 24h** e são apagados na inicialização, ao enviar o item ou ao remover a mídia.

---

## 11. Backend (Supabase)

> **Qual código está em uso:** a extensão conversa com a Edge Function `client-project-qa` do repositório **WiControl** ([WiControl/supabase/functions/client-project-qa/index.ts](../WiControl/supabase/functions/client-project-qa/index.ts), arquivo único). A pasta `extension-base/supabase/` tem uma versão modular antiga, que **não tem a rota `/diagnostic`** usada pela extensão. Não publique a partir dela.

### Endpoints usados

Base: `https://<projeto>.supabase.co/functions/v1`

| Método e rota | Uso |
|---|---|
| `POST /client-access/verify` | Senha de convidado → `{ token, expiresAt }` (12h). |
| `GET /client-project-qa/snapshot?token=…&includeMembers=…` | Projeto, itens, comentários e membros. Valida a conexão e lista os itens. |
| `POST /client-project-qa/media/init` | Registra a mídia e devolve a URL de upload assinada. |
| `POST /client-project-qa/media/complete` | Confirma o upload. |
| `GET /client-project-qa/media/status` | Status de uma mídia (não usado pela extensão hoje). |
| `POST /client-project-qa/diagnostic` | Grava o pacote de diagnóstico (máx. 1 MB no servidor). |
| `POST /client-project-qa/item` | Cria o item com anexos e diagnóstico. |
| `PUT /client-project-qa/item`, `POST /client-project-qa/comment` | Existem no backend, mas a extensão não os usa. |

### Cabeçalhos

```
apikey: <chave pública>
Authorization: Bearer <chave pública>     # só se a chave for JWT (anon legada)
Idempotency-Key: <uuid>                   # init de mídia, diagnóstico, item
x-client-access-token: <token>            # modo convidado
x-wiflow-session-token / x-wiflow-user-id # modo WiFlow
```

O backend busca o projeto por `projects.client_share_token`. O token de convidado é conferido por hash em `client_access_sessions` (com `expires_at`). A sessão WiFlow é validada em `WIFLOW_API_PROXY_BASE/auth/check-session`.

### Tabelas e storage

- `qa_items`, `qa_comments`, `qa_media`, `qa_item_attachments`, `qa_diagnostic_sessions`, `qa_item_diagnostics`, `qa_request_idempotency`, `client_access_sessions`.
- Bucket privado `qa-media`. As URLs de leitura são assinadas por **10 minutos** e geradas de novo a cada snapshot.
- Os diagnósticos expiram em **90 dias** (`qa_diagnostic_sessions.expires_at`).
- Migrations: `WiControl/supabase/migrations/202609120001_qa_media.sql` e `202609270001_qa_diagnostics.sql`.

### Limites aceitos pelo servidor

| Tipo | MIME | Máximo |
|---|---|---|
| Imagem | `image/png`, `image/jpeg`, `image/webp` | 10 MB |
| Vídeo | `video/webm`, `video/mp4` | 50 MB |
| Áudio | `audio/webm`, `mpeg`, `mp4`, `wav` | 6 MB (o backend aceita, mas a extensão não grava mais áudio) |

### Secrets da Edge Function

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetadas pelo Supabase. Também são lidas: `WIFLOW_API_PROXY_BASE`, `WIFLOW_SUPABASE_URL`, `WIFLOW_SECRET_KEY` (ou `WIFLOW_SUPABASE_SERVICE_ROLE_KEY` / `WIFLOW_SERVICE_ROLE_KEY`), além de `OPENAI_API_KEY` e `OPENAI_TRANSCRIBE_MODEL`, usadas na transcrição de áudio.

A extensão em si **não usa variáveis de ambiente**: URL e chave ficam fixas em `shared/config.js`.

---

## 12. Privacidade e redação de dados

- **Chaves sensíveis:** campos e parâmetros de URL cujo nome casa com `pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credit|card|cvv|cpf|email|phone|telefone` viram `[REDACTED]`. Isso vale nos argumentos de console serializados, nas query strings e no backend. O `#hash` das URLs é removido.
- **Elementos privados:** `input[type=password]`, `[data-private]`, `[data-wiqa-mask]` e seus descendentes têm rótulo, nome acessível e HTML trocados por `[REDACTED]`. **Para esconder uma área do site do QA, marque-a com `data-wiqa-mask`.**
- **Valores digitados** nunca são capturados, e headers e corpos de requisição também não.
- **Truncamento:** strings até 4096 caracteres; objetos com profundidade e número de chaves limitados; URLs até 2048 caracteres.
- `storage.local` fica restrito a `TRUSTED_CONTEXTS`, então scripts na página não leem a config.
- A extensão só usa chaves **públicas**. Toda escrita com privilégio acontece na Edge Function.

**Limites da redação:**

- Ela é feita pelo **nome** da chave, não pelo valor. Um e-mail ou token dentro de um texto de `console.log` passa sem redação.
- A regex gera falsos positivos (ex.: `sessionId`, `cardinality`).
- Eventos do observer usam `postMessage('*')`, então a própria página pode forjar eventos de diagnóstico.

---

## 13. Permissões do Chrome

| Permissão | Por quê |
|---|---|
| `activeTab` | Agir na aba ativa a partir do ícone. |
| `scripting` | Injetar os scripts sob demanda. |
| `storage` | Config, rascunho, metadados e diagnóstico. |
| `offscreen` | Documento para `MediaRecorder`. |
| `tabCapture` | Gravação de vídeo da aba. |
| `sidePanel` | Painel lateral. |
| `contextMenus` | Item "Reportar este elemento" no botão direito (não gera aviso de permissão). |
| `webRequest` | Registrar requisições de recursos no diagnóstico (só leitura, sem bloquear). |
| `host_permissions: https://gfzsahqvxloggzlvrpxr.supabase.co/*` | API e upload no Supabase de produção. |
| `optional_host_permissions: <all_urls>` | Pedido em tempo de uso: captura e injeção nas páginas. |

---

## 14. Limites e constantes

| Item | Valor | Onde |
|---|---|---|
| Lado máximo da imagem | 2560 px | `IMAGE_MAX_DIMENSION` (service worker) |
| Qualidade WebP | 0,82 | `IMAGE_WEBP_QUALITY` |
| Prévia do elemento | 900 px, folga de 8 px | `ELEMENT_PREVIEW_*` |
| Retenção local de blobs | 24 h | `media-store.js`, `offscreen.js` |
| Console / rede / passos por rascunho | 500 / 300 / 200 eventos (descarta os mais antigos) | `appendDiagnosticEvent` |
| Elementos por rascunho | 10 | `appendDiagnosticEvent` |
| Payload de diagnóstico | 900 KB (cliente) / 1 MB (servidor) | `diagnosticPayload` / `MAX_DIAGNOSTIC_BYTES` |
| Timeout padrão da API | 30 s (complete: 60 s; upload: 60 s) | `api-client.js` |
| Timeout ao criar item | 60 s | painel |
| Sessão de convidado | 12 h | `client-access` |
| Cache da lista de itens | 5 min | `ITEMS_STALE_MS` |
| Design no Fiscal do Pixel | até 40 MB | `PIXEL_REFERENCE_MAX_BYTES` |
| Descrição / Local | 5000 / 100 caracteres | painel |

---

## 15. Desenvolvimento

```bash
cd extension-base
npm test           # node --test tests/*.test.mjs
npm run validate   # confere o manifesto MV3 e os arquivos referenciados
```

`validate-extension.mjs` falha se:

- o manifesto não for MV3 ou tiver Chrome mínimo abaixo de 116;
- `<all_urls>` aparecer em `host_permissions`;
- houver `content_scripts` globais;
- faltar algum arquivo referenciado;
- algum HTML carregar script ou estilo remoto.

**Depurar:**

| Parte | Como abrir |
|---|---|
| Service worker | `chrome://extensions` → WiControl QA → "Inspecionar visualizações: service worker". |
| Painel lateral | Botão direito no painel → Inspecionar. |
| Scripts da página | DevTools da aba. O `injected.js` aparece no contexto "WiControl QA" do seletor de contexto do console. |
| Offscreen | `chrome://extensions` → "offscreen.html" (só existe durante a gravação). |

**Supabase local:** para desenvolver contra o `supabase start` do repositório WiControl:

1. troque temporariamente os valores de `shared/config.js` por `http://127.0.0.1:54421` e pela chave do `supabase status`;
2. adicione `http://127.0.0.1:54421/*` em `host_permissions`;
3. recarregue a extensão.

Nesse ambiente, URLs assinadas com host `kong:8000` são reescritas automaticamente. Não publique com esses valores.

**Trocar o projeto Supabase:** atualize `shared/config.js` **e** `host_permissions` no `manifest.json`, depois publique uma nova versão. Quem já usa a extensão precisará conectar de novo.

**Convenções:**

- Sem dependências externas, e nenhum HTML pode carregar recursos remotos.
- Toda interface injetada na página fica em Shadow DOM fechado, com `z-index` máximo.
- Mensagens novas: registre em `dispatchMessage` (service worker) e aumente `BACKGROUND_PROTOCOL_VERSION` e `REQUIRED_BACKGROUND_PROTOCOL` juntos.

---

## 16. Limitações conhecidas e pontos de atenção

- **Troca de chave exige nova versão:** com URL e anon key fixas, rotacionar a chave ou mudar de projeto exige publicar uma versão nova (revisão da Chrome Web Store).
- **Gravação oculta:** a gravação de tela está implementada, mas o botão está escondido.
- **Modo WiFlow inacessível:** o modo WiFlow não aparece na interface, então o campo **Responsável** fica sempre desabilitado.
- **Itens só leitura:** não dá para editar itens nem comentar pela aba Itens.
- **Anotação limitada:** sem ferramenta de texto (o editor da prévia do elemento tem desfazer; o do screenshot, não).
- **Visualização responsiva:** recarrega a página num iframe. Não funciona em sites que bloqueiam frames e perde o estado não salvo.
- **Gravação e outras superfícies:** só existe uma superfície na página por vez. Começar uma gravação fecha o Fiscal do Pixel. Abrir recorte ou Fiscal durante a gravação remove a barra, mas não para o cronômetro interno.
- **Stack cortado:** o stack dos erros é cortado em 4096 caracteres na sanitização, embora o observer guarde até 12000.
- **`duration_ms` do `fetch`:** mede o tempo até os headers, não o download completo.
- **Reenvio só com o painel aberto:** as tentativas automáticas rodam no painel; com ele fechado, retomam ao reabrir.
- **Código legado:** `extension-base/supabase/` está desatualizado em relação ao backend real.

---

## 17. Documentos relacionados

- [SPEC_DRIVEN_DEVELOPMENT_WICONTROL_QA.md](SPEC_DRIVEN_DEVELOPMENT_WICONTROL_QA.md): especificação funcional e contratos.
- [qa_api_reference.md](qa_api_reference.md): referência da API de QA.
- [PLANO_IMPLEMENTACAO_AUDIO_SUPABASE_UI.md](PLANO_IMPLEMENTACAO_AUDIO_SUPABASE_UI.md): plano de mídia, áudio e UI (o áudio foi removido depois).
- [WiControl/docs/](../WiControl/docs/): documentação do sistema WiControl (arquitetura, edge functions, deploy, portal do cliente).
