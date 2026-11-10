# Publicar o VideoBridge (uma vez + a cada versão)

## Uma vez só
1. Crie um repositório **público** no GitHub (Pages e a consulta de versão do app precisam disso) e suba esta pasta (`git push`).
2. Em *Settings → Pages → Build and deployment → Source*, escolha **GitHub Actions**.
3. Rode o workflow **pages** (aba *Actions* → pages → *Run workflow*). A página de convite fica em
   `https://SEU-USUARIO.github.io/SEU-REPO/`.
4. No app: ⋮ Configurações → **Página de convite** → cole essa URL. Pronto: o link do Discord passa a ser clicável.

## A cada versão
1. Aumente `version` em `Cargo.toml` (seção `[workspace.package]`), ex.: `0.3.0`.
2. `git commit` e crie a tag com o mesmo número: `git tag v0.3.0 && git push origin v0.3.0`.
3. O workflow **release** roda os testes, compila e publica `VideoBridge.exe` + `.sha256` em *Releases*.
4. Mande aos amigos o link fixo `https://github.com/SEU-USUARIO/SEU-REPO/releases/latest`.

Quem já tem o app instalado vê **"⬆ Nova versão vX — baixar"** no menu da bandeja (a verificação roda 15 s depois de abrir
e a cada 6 h; só existe em builds feitos pelo workflow, que define `VB_REPO`).

## Aviso do Windows (SmartScreen)
Sem assinatura de código, a 1ª execução mostra "O Windows protegeu seu PC": *Mais informações → Executar assim mesmo*.
Para conferir que o arquivo não foi alterado: `Get-FileHash VideoBridge.exe -Algorithm SHA256` e compare com o `.sha256`.
