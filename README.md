# VideoBridge (Rust) — fase 1

Reescrita do VideoBridge. O Electron saiu; o processo principal, a rede, o Discord e o áudio por aplicativo agora são Rust.
**Status: escrito sem poder compilar** (o ambiente onde foi feito não tinha Rust nem rede). Veja "Estado" abaixo.

## Estrutura
| Pasta | O quê |
|---|---|
| `crates/vb-core` | Portátil e testável: convite/cripto da sala, relay (ntfy) cifrado, config, Discord, log, TURN |
| `crates/vb-audio` | Áudio por aplicativo (Windows 10 2004+) **dentro do processo**: captura por processo, mixer, limitador |
| `crates/vb-app` | `videobridge.exe`: bandeja, atalhos, instância única, protocolo `videobridge://`, janela WebView2, ponte IPC |
| `ui/` | Interface (HTML/JS/CSS) e a lógica WebRTC — herdada do app original, com ajustes |
| `ui-tests/` | Testes JS da interface (111, rodam com Node) |

## Compilar e testar
```powershell
# Windows, com Rust (rustup) e o WebView2 Runtime (já vem no Windows 11)
cargo build --release -p vb-app        # → target\release\videobridge.exe
cargo test -p vb-core -p vb-audio      # também roda em Linux/macOS (a parte de Windows é compilada só no Windows)
node --test ui-tests/*.test.js
```
Opcional: `--features auto-permissions` (aceita microfone/câmera sem o aviso do WebView2; precisa de `webview2-com` na mesma versão do `wry`).

## O que mudou (e por quê)
**Peso**: sem Chromium embutido (usa o WebView2 do sistema) e sem Node. Em idle: bandeja + runtime Tokio, sem janela.
**Áudio**
- O helper `VbAudio.cs` (1,7 mil linhas, compilado no PC do usuário com `csc.exe`, falando por stdin/stdout/stderr) virou código Rust em processo: sem etapa de compilação, sem cache de `.exe`, sem processo filho, sem pipes.
- A combinação de formato/flags **documentada pela Microsoft** é tentada primeiro (a matriz antiga fica como rede de segurança); thread de captura com prioridade MMCSS ("Pro Audio").
- Modo **"tudo menos o VideoBridge"** = uma captura só (modo EXCLUDE do Windows): uma thread, e apps novos entram no instante em que abrem. Qualquer bloqueio individual volta ao modo por aplicativo.
- Relógio de saída sem deriva (microssegundos) e **limitador** no lugar do corte seco (somar vários apps distorcia).
**Conexão**
- Relay: timeout de leitura de 90 s (antes uma conexão morta em silêncio deixava o app "online" sem receber nada), publicações serializadas, backoff com `Retry-After`.
- Protocolo `VB3`: tópico como AAD no AES-GCM e **compressão** antes de cifrar (SDP cabe em 1 mensagem em vez de 2–3 → menos chance de bater no limite do ntfy). *Não é compatível com o `VB2` do app antigo.*
- Renegociações (adicionar/tirar tela) passam pelo **canal de dados P2P** assim que ele abre; o relay só serve ao primeiro contato.
- ICE termina 0,7 s depois do 1º endereço público em vez de esperar até 6 s.
**Discord**: UM aviso por sala, publicado quando a sala é CRIADA (verde, "Sala aberta") e editado para listar quem está na sala e o que cada um compartilha (vermelho); dura até a sala esvaziar — se o dono sair com gente dentro, quem tiver o mesmo webhook assume a mensagem; senão o app do dono vira "vigia" (continua ouvindo o relay, sem WebRTC) e apaga a mensagem quando o último sair. Todos mandam um batimento (`hb`) a cada 60 s para o vigia saber quem ainda está lá. Link clicável pela página-ponte (`docs/join`, hospedada no GitHub Pages). Aviso órfão é apagado na próxima abertura (id salvo em disco, sem token); edições agrupadas (≤1 a cada 1,5 s) e `Retry-After` respeitado; mensagem em *embed* com horário relativo; nomes escapados.
**Segurança**: UI embutida e servida por protocolo próprio (nada de `file://`, nenhuma porta de rede), navegação e janelas novas bloqueadas, IPC só aceito da nossa origem, instância única por *named pipe*.
**Rich Presence (convite pelo perfil)**: o app publica a sala no seu perfil do Discord pelo soquete local (`crates/vb-core/src/rpc.rs` + `crates/vb-app/src/rich.rs`, ID do aplicativo embutido). Quem pode "Entrar" é definido pela privacidade do Discord do dono; pedidos de entrada são recusados. Sem webhook, sem servidor. Desligável em Configurações.
**Aparência**: logo (monitor com play, verde do app) em `ui/assets/logo.svg`; ícones dos botões são máscaras SVG em `ui/assets/icons/` (herdam a cor do texto; sem emojis); ícone do `.exe`/janela/bandeja em `crates/vb-app/assets/` e `ui/assets/tray*.png`. Versão simplificada (traço mais grosso) para 16–48 px. Arquivos-fonte para o Discord em `docs/brand/`.
**Robustez da sala (v0.3.1)**: sair nunca espera a rede (a despedida e o aviso do Discord seguem em segundo plano); todo envio ao relay tem prazo (8 s por requisição, 15 s no total) e um aviso aparece se o relay estiver recusando mensagens; um `closed` de quem chegou e não viu ninguém não encerra mais a sala (nem para o dono, nem no histórico); códigos sem relay usam o relay padrão; batimentos só quando o dono vigia o aviso do Discord.
**Distribuição**: workflows do GitHub Actions (`.github/workflows`) compilam e publicam o release; o app avisa na bandeja quando há versão nova. Veja `docs/RELEASING.md`.
**Log** com rotação (2 MB).

## O que NÃO é Rust (e por quê)
Captura de tela/câmera, encoder H.264 por hardware, WebRTC (controle de congestionamento, jitter buffer, cancelamento de eco) e a interface continuam no **Chromium do WebView2**. Trocar isso por Rust puro significa reimplementar essa pilha (ou usar o libwebrtc via crate, que no Windows cai em H.264 por *software*, mais pesado que o atual). É a "fase 2", e vale decidir com dados da fase 1.

## Limitação conhecida da troca para WebView2
O Electron deixava o app escolher a fonte da captura por id; o WebView2 mostra o **seletor do próprio navegador** (uma fonte por clique). O seletor próprio com miniaturas (Telas/Janelas) só roda no modo Electron e foi desligado aqui (`vb.nativePicker`). O áudio do sistema passa a vir só do helper em Rust (Windows 10 2004+); sem ele, só o dispositivo alternativo ("Mixagem estéreo").

## Estado — leia antes de confiar
- ✅ Rodado: os 111 testes JS da interface (inclui 4 novos).
- ⚠️ **Não compilado nem executado**: todo o Rust (≈3,5 mil linhas, incluindo testes unitários escritos junto). Espere alguns erros de compilação, principalmente onde as bibliotecas mudam de API: `wry`/`tao` (assinatura do protocolo customizado), `windows` 0.58 (`PROPVARIANT`, `AvSetMmThreadCharacteristicsW`), `tray-icon`. As versões estão fixadas em `Cargo.toml`.
- ⚠️ **Nunca testado contra o Windows/Discord/ntfy reais**: captura por processo, seletor do WebView2, relay e webhooks.
- Ordem sugerida: `cargo test -p vb-core -p vb-audio` (corrige primeiro o que for puro) → `cargo build -p vb-app` → abrir e testar sala com 2 PCs → áudio por app (`⋮ → Executar diagnóstico`).
