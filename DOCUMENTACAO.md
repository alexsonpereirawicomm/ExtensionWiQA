# Documentação do Projeto: WiControl QA

Este documento resume a arquitetura, funcionalidades atuais e a estrutura de pastas do projeto de extensão para o navegador (Manifest V3), a fim de guiar o desenvolvimento atual e ajudar a IA em etapas futuras.

## Visão Geral
**Nome:** WiControl QA
**Descrição:** Ferramenta de captura de tela (screenshot) e gravação em vídeo voltada para o processo de Quality Assurance (QA) da Wicomm.

## Estrutura do Projeto

A extensão é dividida nos seguintes módulos principais:

### 1. `manifest.json`
- Utiliza **Manifest V3**.
- Permissões solicitadas: `activeTab`, `scripting`, `storage`, `offscreen`, `tabCapture`.
- Host permissions: `<all_urls>` para poder injetar scripts e gravar qualquer página.
- Registra o service worker (background script) e scripts de conteúdo (injetados no carregamento da página).

### 2. Service Worker (`background/background.js`)
Atua como o orquestrador central da extensão, comunicando-se via troca de mensagens (`chrome.runtime.sendMessage`).
- **Screenshot:** Usa `chrome.tabs.captureVisibleTab` para tirar a foto da aba. Injeta dinamicamente os scripts e estilos do `content` (se necessário) e envia a imagem para a página para que o usuário faça o recorte (crop).
- **Gravação de Vídeo:** Obtém o ID do stream da aba com `chrome.tabCapture.getMediaStreamId` e gerencia a criação de um documento `offscreen` para lidar com a gravação real do vídeo.
- **Armazenamento:** Salva a mídia capturada (foto ou vídeo) no `chrome.storage.local` para ser exibida no Popup.

### 3. Content Scripts (`content/content.js` e `content/content.css`)
Injetados na página ativa do usuário para interagir diretamente com o DOM.
- **Overlay de Crop e Anotação:** Após capturar a tela, escurece a interface e permite arrastar para recortar uma área. Logo em seguida, abre um `<canvas>` com ferramentas de anotação (caneta livre, retângulo, seta, paleta de cores) para editar a imagem antes de enviá-la para o Popup.
- **Countdown (Contagem regressiva):** Exibe uma animação na tela "3, 2, 1" antes de iniciar a gravação de vídeo.
- **Barra de Gravação Flutuante:** Exibe um relógio em tempo real da gravação e um botão para interromper a gravação dentro da própria aba.

### 4. Offscreen Document (`offscreen/offscreen.html` e `offscreen/offscreen.js`)
Necessário no Manifest V3 para contornar a limitação de Service Workers que não possuem acesso a APIs de mídia do DOM.
- **MediaRecorder:** Utiliza `navigator.mediaDevices.getUserMedia` com a origem da aba e gerencia os `chunks` do vídeo.
- Após o término, compila o vídeo em um blob `video/webm` e o envia de volta ao background.

### 5. Popup (`popup/popup.html`, `popup/popup.css` e `popup/popup.js`)
A interface principal que o usuário vê ao clicar no ícone da extensão.
- **Views Dinâmicas:** 
  - *Default:* Botões iniciais de "Tirar Print" e "Gravar Tela".
  - *Recording:* Exibe o timer enquanto uma gravação está acontecendo.
  - *Result:* Pré-visualização da mídia capturada (imagem ou vídeo) acoplada a um formulário.
- **Formulário de QA:** Permite inserir Descrição, Prioridade, Status e exibe a URL atual da página.
- **Integração:** Valida os campos, empacota as informações e a mídia em um `FormData`. *Atualmente o envio de dados via `fetch` está apenas mockado e simulando o delay de rede.*

## Funcionalidades Implementadas
✅ Tirar captura da aba ativa.
✅ Ferramenta de seleção de área (crop) injetada na página do usuário.
✅ Ferramenta de anotações (desenho livre, retângulo, setas e cores) nativa logo após o recorte da imagem.
✅ Gravação de vídeo em tempo real da aba ativa utilizando Offscreen Document.
✅ Contagem regressiva antes da gravação e overlay com relógio e botão de parar.
✅ Salvamento de estado no `chrome.storage.local` (permitindo fechar e abrir o popup e manter a tela de gravação ou preview).
✅ Formulário no Popup para preenchimento dos dados do bug/tarefa, atrelado à mídia capturada e à URL atual da aba.

✅ **Fiscal do Pixel** (ferramenta "só visualização" abaixo do cartão da página, fora das etapas do registro): modo de inspeção na aba ativa (`content/injected.js` → `openPixelInspector`).
   - Ao carregar um design, a tela vira uma visualização (preset `design`) com a largura do design em px CSS (largura da imagem ÷ escala do export). A altura também é a do design quando cabe na tela; em designs de página inteira a moldura usa a altura disponível e a página rola junto. Remover o design ou sair do Fiscal volta para a tela inteira.
   - Hover mostra o box model (margem, borda, preenchimento, conteúdo) e uma ficha com dimensões e tipografia (fonte, tamanho, peso, altura da linha, espaçamento, cor e fundo). Clique fixa o elemento e libera "Copiar specs".
   - Design de referência (PNG/JPG/WebP do Figma) carregado por botão, Ctrl+V ou arrastar; sobreposto em 1:1 com escala do export (1x–4x, detectada pela largura), opacidade, modo diferença e deslocamento por setas (Shift = 10px). Funciona também dentro da visualização responsiva.
   - "Capturar evidência" (tecla P) esconde a barra, captura a aba (`WI_QA_PIXEL_CAPTURE`) e anexa a imagem ao rascunho como `pixel-perfect-*.webp`.

## Próximos Passos / TODOs Identificados no Código
1. **Integração real com a API:** 
   - No arquivo `popup/popup.js` (aprox. linha 200), existe um comentário `TODO: Substituir pela URL real da API`. O envio do formulário no botão de *Submit* ("Enviar Formulário de QA") está com um `fetch` mockado que espera 1.5 segundos simulando sucesso. É necessário apontar para o endpoint real do backend da Wicomm, que deverá estar pronto para receber dados *multipart/form-data* com o arquivo e os campos de texto.
