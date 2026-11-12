// Embute o ícone e as informações de versão no videobridge.exe (aparece na barra de tarefas, no Explorer e no Gerenciador de Tarefas).
fn main() {
    println!("cargo:rerun-if-changed=assets/videobridge.ico");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/videobridge.ico");
        res.set("ProductName", "VideoBridge");
        res.set("FileDescription", "VideoBridge");
        // sem o kit de desenvolvimento do Windows (rc.exe) o app compila igual, só que sem o ícone no .exe
        if let Err(e) = res.compile() {
            println!("cargo:warning=não foi possível embutir o ícone no .exe: {e}");
        }
    }
}
