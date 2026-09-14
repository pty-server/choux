pub mod http;
pub mod response;

use tokio::io::{AsyncRead, AsyncWrite};

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

pub enum Endpoint {
    #[cfg(unix)]
    UnixSocket(std::path::PathBuf),
}

impl Endpoint {
    pub async fn connect(&self) -> std::io::Result<Box<dyn Duplex>> {
        match self {
            #[cfg(unix)]
            Self::UnixSocket(path) => Ok(Box::new(tokio::net::UnixStream::connect(path).await?)),
        }
    }
}
