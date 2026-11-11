//! Integração com o Windows: protocolo `videobridge://` e início automático (registro do usuário atual,
//! sem precisar de administrador).
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

fn exe() -> Option<String> {
    std::env::current_exe().ok().map(|p| p.display().to_string())
}

/// Registra `videobridge://` para o usuário atual (só grava se mudou).
pub fn register_protocol() {
    let Some(exe) = exe() else { return };
    let cmd = format!("\"{exe}\" \"%1\"");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(r"Software\Classes\videobridge") else { return };
    let _ = key.set_value("", &"URL:VideoBridge");
    let _ = key.set_value("URL Protocol", &"");
    if let Ok((c, _)) = key.create_subkey(r"shell\open\command") {
        let cur: Result<String, _> = c.get_value("");
        if cur.map(|v| v != cmd).unwrap_or(true) {
            let _ = c.set_value("", &cmd);
        }
    }
}

/// `discord-<ID>://`: é por ele que o Discord abre o app quando alguém entra pelo perfil (o segredo chega depois, pelo soquete).
pub fn register_discord_protocol(app_id: &str) {
    let Some(exe) = exe() else { return };
    let cmd = format!("\"{exe}\" \"%1\"");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(format!(r"Software\Classes\discord-{app_id}")) else { return };
    let _ = key.set_value("", &"URL:VideoBridge (Discord)");
    let _ = key.set_value("URL Protocol", &"");
    if let Ok((c, _)) = key.create_subkey(r"shell\open\command") {
        let cur: Result<String, _> = c.get_value("");
        if cur.map(|v| v != cmd).unwrap_or(true) {
            let _ = c.set_value("", &cmd);
        }
    }
}

pub fn set_autostart(on: bool) {
    let Some(exe) = exe() else { return };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((run, _)) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else { return };
    if on {
        let _ = run.set_value("VideoBridge", &format!("\"{exe}\" --hidden"));
    } else {
        let _ = run.delete_value("VideoBridge");
    }
}
