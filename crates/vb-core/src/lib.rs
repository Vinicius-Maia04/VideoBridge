//! Núcleo portátil do VideoBridge: convite/cripto da sala, relay de signaling,
//! configuração, integração com o Discord e log. Sem dependência de Windows,
//! então tudo aqui é testável em qualquer sistema (`cargo test -p vb-core`).
pub mod config;
pub mod discord;
pub mod logger;
pub mod relay;
pub mod room;
pub mod turn;
pub mod update;
