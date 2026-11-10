# Plano de testes

## Automáticos (`npm test`, rodam em qualquer SO)
Código de sala e cifra, relay (pedaços, histórico, reconexão), estados, qualidade/codecs, config, Discord (mock), redação de logs, fiação UI↔HTML↔IPC, CSP e um teste de fumaça que EXECUTA host.js/viewer.js com `vb` não configurável (como o contextBridge) e clica nos botões.

## Manuais — primeiro marco (2 PCs Windows)
0. **⋮ Configurações → Executar diagnóstico** e confirme `Relay de signaling: OK`. Se falhar, ninguém consegue entrar (troque/autohospede o relay).
1. `npm install && npm start` nos dois PCs.
2. PC A: **Criar sala**, 🖥 compartilhar **Monitor 1** (veja a prévia). PC B: **Entrar** com o código — deve aparecer na lista e ver a tela do A sozinho.
3. B liga o 🎙 e a 📷; A vê a câmera e ouve. A para e volta a compartilhar sem ninguém reentrar.
4. Confira no diagnóstico `P2P OK` e `Encoder` de hardware (`MediaFoundation…`). Sair libera tudo.
5. Idle: com o app só na bandeja, CPU/GPU ≈ 0% no Gerenciador de Tarefas.
6. Cenários: redes diferentes, IPv6, janela fechada durante o compartilhamento (aviso na UI), áudio do sistema, 2 telas + câmera, 3–4 participantes, hotkeys, Discord (aviso criado, atualizado e removido; link da página-ponte).
7. **Novos controles:** em um PC, compartilhe a tela e, no outro, teste foco, zoom (roda e arrastar), tela cheia (⛶ e duplo clique), volume/mudo da transmissão, volume do microfone por pessoa e os efeitos sonoros (entrar/sair, ligar câmera, iniciar tela).
7b. **Sala encerrada:** crie uma sala, copie o código, saia e tente entrar de novo com ele: deve ser recusado. Repita matando o processo do app (Gerenciador de Tarefas) em vez de sair: a recusa vem após ~8 s.
7c. **Áudio do sistema:** se o aviso reaparecer, anote o resultado de *Executar diagnóstico → Áudio do sistema (teste agora)* e a linha `System audio failed` do log (`%APPDATA%\videobridge\logs\videobridge.log`).
7d. **Áudio por aplicativo (validação do helper nativo):** abra o Chrome tocando um vídeo e o Spotify. Em ⋮ → Executar diagnóstico confira `Áudio por aplicativo: OK` e `teste de captura por processo: OK`. Compartilhe a tela, ligue o 🔊 e abra o 🎚: Chrome e Spotify devem aparecer com medidor. Em outro PC, ouça os dois; desligue o Chrome (deve sumir na hora, sem corte no Spotify); religue. Confirme que a **voz do outro participante não volta** para ele (sem eco). Se `teste de captura por processo` falhar, o diagnóstico lista as **tentativas** (formato/flags → HRESULT do Windows): envie essa lista. Se a primeira compilação falhar, o diagnóstico mostra a saída do `csc.exe`; teste à mão com `native/README.md`.
7e. **Conectividade:** de um PC em outra rede (ex.: celular como roteador), entre na sala. Se falhar, confira que a mensagem aponta o lado sem endereço público e a ação certa. Teste com um TURN próprio (⋮ Configurações → Rede) em **só um** dos lados: a conexão deve fechar, e o amigo deve receber o TURN pela sala (veja `Peer state` no log).
7f. **Áudio vinculado à tela:** compartilhe uma tela com áudio; no outro PC ouça. Pare a tela: o áudio deve parar junto (e o 🔊 ficar desativado). Teste com duas telas: parar uma mantém o áudio, parar a última o encerra. No seletor, confira as seções **Telas inteiras** e **Janelas**.
8. Rede ruim (Clumsy/netem): observe a queda gradual (`Adaptive quality` no log) e a subida lenta.
8. Matriz de hardware: NVIDIA / AMD / Intel / só CPU — anote o `encoder` na barra de status.

## Benchmark básico
Na barra de status, a linha de cada participante mostra codec, resolução, FPS, bitrate, perda, RTT e encoder (a cada 2 s). Registre também CPU/GPU/VRAM no Gerenciador de Tarefas.
