//! Verificação de nova versão nos *releases* do GitHub (só avisa; quem baixa e troca o arquivo é você).
//! O repositório vem do build (`VB_REPO=dono/nome`, que o workflow do GitHub define sozinho); sem isso, nada é consultado.
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tag: String,
    pub url: String,
}

/// `v1.2.3`, `1.2.3` ou `1.2.3-beta` → (1, 2, 3).
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let core = s.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next()?;
    let mut it = core.split('.');
    let v = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next().unwrap_or("0").parse().ok()?);
    it.next().is_none().then_some(v)
}

pub fn is_newer(current: &str, latest: &str) -> bool {
    matches!((parse_version(current), parse_version(latest)), (Some(c), Some(l)) if l > c)
}

/// `dono/nome`, só caracteres seguros (vai parar numa URL).
pub fn valid_repo(s: &str) -> bool {
    let ok = |p: &str| !p.is_empty() && p != "." && p != ".." && p.len() <= 100 && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'.');
    matches!(s.split_once('/'), Some((o, n)) if ok(o) && ok(n) && !n.contains('/'))
}

/// Extrai o release de uma resposta de `GET /repos/{repo}/releases/latest` (ignora rascunho e pré-lançamento).
pub fn parse_release(v: &Value) -> Option<Release> {
    if v["draft"].as_bool() == Some(true) || v["prerelease"].as_bool() == Some(true) {
        return None;
    }
    let (tag, url) = (v["tag_name"].as_str()?, v["html_url"].as_str()?);
    // o link só é aceito se for do próprio GitHub (ele é aberto no navegador)
    (url.starts_with("https://github.com/") && !url.contains(char::is_whitespace)).then(|| Release { tag: tag.into(), url: url.into() })
}

/// `Ok(Some(_))` só se houver versão MAIS NOVA que `current`.
pub async fn check(client: &reqwest::Client, repo: &str, current: &str) -> Result<Option<Release>, String> {
    if !valid_repo(repo) {
        return Err("repositório inválido".into());
    }
    let res = client
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().as_u16() == 404 {
        return Ok(None); // ainda sem release (ou repositório privado)
    }
    if !res.status().is_success() {
        return Err(format!("GitHub respondeu HTTP {}", res.status().as_u16()));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(parse_release(&v).filter(|r| is_newer(current, &r.tag)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_parse_and_compare() {
        assert_eq!(parse_version("v0.2.10"), Some((0, 2, 10)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("1.2.3-beta+x"), Some((1, 2, 3)));
        assert_eq!(parse_version("lixo"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert!(is_newer("0.2.0", "v0.2.1") && is_newer("0.9.0", "v0.10.0"));
        assert!(!is_newer("0.2.0", "v0.2.0") && !is_newer("0.3.0", "v0.2.9") && !is_newer("0.2.0", "nada"));
    }
    #[test]
    fn repo_names() {
        assert!(valid_repo("fulano/videobridge") && valid_repo("a-b/c_d.e"));
        assert!(!valid_repo("sem-barra") && !valid_repo("a/b/c") && !valid_repo("a b/c") && !valid_repo("../x") && !valid_repo("/x") && !valid_repo("x/"));
    }
    #[test]
    fn release_parsing_rejects_drafts_prereleases_and_foreign_links() {
        let ok = json!({"tag_name": "v1.0.0", "html_url": "https://github.com/a/b/releases/tag/v1.0.0"});
        assert_eq!(parse_release(&ok).unwrap().tag, "v1.0.0");
        assert!(parse_release(&json!({"tag_name": "v1", "html_url": "https://github.com/a/b/x", "draft": true})).is_none());
        assert!(parse_release(&json!({"tag_name": "v1", "html_url": "https://github.com/a/b/x", "prerelease": true})).is_none());
        assert!(parse_release(&json!({"tag_name": "v1", "html_url": "https://evil.com/x"})).is_none());
        assert!(parse_release(&json!({"tag_name": "v1"})).is_none());
    }
}
