//! Texto legível para HRESULTs de áudio (o diagnóstico mostra isso ao usuário).
pub fn text(hr: i32) -> String {
    let name = match hr as u32 {
        0x8889_0001 => "AUDCLNT_E_NOT_INITIALIZED",
        0x8889_0002 => "AUDCLNT_E_ALREADY_INITIALIZED",
        0x8889_0003 => "AUDCLNT_E_WRONG_ENDPOINT_TYPE",
        0x8889_0004 => "AUDCLNT_E_DEVICE_INVALIDATED",
        0x8889_0008 => "AUDCLNT_E_UNSUPPORTED_FORMAT",
        0x8889_000A => "AUDCLNT_E_DEVICE_IN_USE",
        0x8889_000E => "AUDCLNT_E_ENDPOINT_CREATE_FAILED",
        0x8889_0019 => "AUDCLNT_E_INVALID_DEVICE_PERIOD",
        0x8889_0021 => "AUDCLNT_E_INVALID_STREAM_FLAG",
        0x8007_0005 => "E_ACCESSDENIED",
        0x8007_0057 => "E_INVALIDARG",
        0x8000_4002 => "E_NOINTERFACE",
        0x8000_4005 => "E_FAIL",
        0x8007_0490 => "E_NOTFOUND",
        _ => "",
    };
    if name.is_empty() { format!("0x{:08X}", hr as u32) } else { format!("0x{:08X} ({name})", hr as u32) }
}
