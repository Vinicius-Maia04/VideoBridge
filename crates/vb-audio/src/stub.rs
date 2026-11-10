//! Fora do Windows o áudio por aplicativo não existe; o crate continua compilando (para os testes portáteis).
use crate::*;

#[derive(Default)]
pub struct Service;

const MSG: &str = "O áudio por aplicativo só existe no Windows.";

impl Service {
    pub fn new() -> Self { Self }
    pub fn status(&self) -> Status { Status { supported: false, reason: Some(MSG.into()), build: None } }
    pub fn list(&self, _self_pid: u32, _p: &Policy) -> Result<Vec<AppInfo>, String> { Err(MSG.into()) }
    pub fn start(&mut self, _p: Policy, _self_pid: u32, _pcm: PcmSink, _ev: EventSink) -> Result<Format, String> { Err(MSG.into()) }
    pub fn update(&self, _p: Policy) -> bool { false }
    pub fn stop(&mut self) {}
    pub fn capture_test(&self, _pid: u32, _secs: u32) -> TestResult { TestResult { error: Some(MSG.into()), ..Default::default() } }
    pub fn probe(&self, _pid: u32) -> Vec<ProbeRow> { vec![] }
}
