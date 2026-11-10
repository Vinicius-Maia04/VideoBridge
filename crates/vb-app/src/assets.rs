//! Interface embutida no executável (nada é lido do disco, nada é servido por porta de rede).
use include_dir::{include_dir, Dir};
use std::borrow::Cow;
use wry::http::{header, Request, Response, StatusCode};

static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../ui");

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

pub fn respond(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let raw = req.uri().path().trim_start_matches('/');
    let path = if raw.is_empty() { "room.html" } else { raw };
    // sem caminhos relativos para fora da pasta embutida
    let file = if path.contains("..") { None } else { UI.get_file(path) };
    match file {
        Some(f) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime(path))
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(Cow::Borrowed(f.contents()))
            .expect("resposta válida"),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b"not found"[..])).expect("resposta válida"),
    }
}
