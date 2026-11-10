//! Descoberta dos aplicativos que estão tocando áudio no dispositivo de saída padrão.
use super::hr;
use crate::AppInfo;
use std::collections::HashMap;
use windows::core::Interface;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub exe: String, // minúsculas
}

pub fn processes() -> HashMap<u32, Proc> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                let exe = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                map.insert(e.th32ProcessID, Proc { pid: e.th32ProcessID, parent: e.th32ParentProcessID, exe });
                if Process32NextW(snap, &mut e).is_err() { break; }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

/// `pid` é descendente de `ancestor`? (para nunca capturar o próprio app e os processos do WebView2 dele)
pub fn is_descendant(pid: u32, ancestor: u32, map: &HashMap<u32, Proc>) -> bool {
    if ancestor == 0 { return false; }
    let mut cur = pid;
    for _ in 0..64 {
        let Some(p) = map.get(&cur) else { return false };
        if p.parent == ancestor { return true; }
        if p.parent == 0 || p.parent == cur { return false; }
        cur = p.parent;
    }
    false
}

/// Sobe na árvore enquanto o pai for o mesmo executável (Chrome: processo de áudio → processo principal),
/// porque a captura por processo pega a ÁRVORE do alvo.
pub fn root_of(pid: u32, map: &HashMap<u32, Proc>) -> u32 {
    let mut cur = pid;
    for _ in 0..32 {
        let Some(p) = map.get(&cur) else { break };
        let Some(par) = map.get(&p.parent) else { break };
        if par.pid == p.pid || par.exe != p.exe { break; }
        cur = par.pid;
    }
    cur
}

fn friendly(key: &str) -> String {
    let known = match key {
        "chrome.exe" => "Google Chrome",
        "msedge.exe" => "Microsoft Edge",
        "firefox.exe" => "Firefox",
        "brave.exe" => "Brave",
        "opera.exe" => "Opera",
        "discord.exe" => "Discord",
        "spotify.exe" => "Spotify",
        "vlc.exe" => "VLC",
        "steam.exe" | "steamwebhelper.exe" => "Steam",
        "obs64.exe" => "OBS Studio",
        "teams.exe" | "ms-teams.exe" => "Microsoft Teams",
        "slack.exe" => "Slack",
        "telegram.exe" => "Telegram",
        "whatsapp.exe" => "WhatsApp",
        _ => "",
    };
    if !known.is_empty() { return known.into(); }
    let stem = key.strip_suffix(".exe").unwrap_or(key);
    let mut c = stem.chars();
    match c.next() { Some(f) => f.to_uppercase().collect::<String>() + c.as_str(), None => key.into() }
}

pub struct Scanned {
    pub apps: Vec<AppInfo>,
}

/// Aplicativos com sessão de áudio no dispositivo padrão (menos o próprio VideoBridge e os sons do sistema).
pub fn scan(self_pid: u32) -> Result<Scanned, String> {
    let procs = processes();
    let mut groups: HashMap<String, AppInfo> = HashMap::new();
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {}", hr::text(e.code().0)))?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia).map_err(|e| format!("GetDefaultAudioEndpoint: {}", hr::text(e.code().0)))?;
        let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None).map_err(|e| format!("Activate(IAudioSessionManager2): {}", hr::text(e.code().0)))?;
        let se = mgr.GetSessionEnumerator().map_err(|e| format!("GetSessionEnumerator: {}", hr::text(e.code().0)))?;
        let count = se.GetCount().map_err(|e| format!("GetCount: {}", hr::text(e.code().0)))?;
        for i in 0..count {
            let Ok(ctl) = se.GetSession(i) else { continue };
            let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = c2.GetProcessId() else { continue };
            if pid == 0 || c2.IsSystemSoundsSession().0 == 0 { continue; } // S_OK = sons do sistema
            if pid == self_pid || is_descendant(pid, self_pid, &procs) { continue; } // nunca captura o próprio app
            let Some(pr) = procs.get(&pid) else { continue };
            let state = ctl.GetState().map(|s| s.0).unwrap_or(0); // 0 inativa, 1 ativa, 2 expirada
            if state == 2 { continue; }
            let peak = ctl.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
            let root = root_of(pid, &procs);
            let entry = groups.entry(pr.exe.clone()).or_insert_with(|| AppInfo { key: pr.exe.clone(), name: friendly(&pr.exe), pid: root, ..Default::default() });
            if state == 1 { entry.active = true; }
            if peak > entry.peak { entry.peak = peak; }
        }
    }
    let mut apps: Vec<AppInfo> = groups.into_values().collect();
    apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Scanned { apps })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(list: &[(u32, u32, &str)]) -> HashMap<u32, Proc> {
        list.iter().map(|(p, par, e)| (*p, Proc { pid: *p, parent: *par, exe: e.to_string() })).collect()
    }
    #[test]
    fn root_climbs_only_through_same_exe() {
        let map = m(&[(1, 0, "explorer.exe"), (10, 1, "chrome.exe"), (11, 10, "chrome.exe"), (12, 11, "chrome.exe")]);
        assert_eq!(root_of(12, &map), 10);
        assert_eq!(root_of(10, &map), 10);
    }
    #[test]
    fn descendants() {
        let map = m(&[(1, 0, "a"), (2, 1, "videobridge.exe"), (3, 2, "msedgewebview2.exe"), (4, 3, "msedgewebview2.exe"), (9, 1, "chrome.exe")]);
        assert!(is_descendant(4, 2, &map));
        assert!(!is_descendant(9, 2, &map));
        assert!(!is_descendant(4, 0, &map));
    }
    #[test]
    fn friendly_names() {
        assert_eq!(friendly("chrome.exe"), "Google Chrome");
        assert_eq!(friendly("meujogo.exe"), "Meujogo");
    }
}
