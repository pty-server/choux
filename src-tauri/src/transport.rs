pub mod bridge;
pub mod http;
pub mod pool;
#[cfg(all(test, unix))]
mod ptys_bridge_tests;
pub mod response;
pub mod target;

use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use bridge::{BridgeProcess, CommandSpec};
use pool::{Connector, Link, LinkFailure};

pub enum Endpoint {
    #[cfg(unix)]
    UnixSocket(std::path::PathBuf),
    Command(CommandSpec),
}

impl Endpoint {
    pub async fn connect(&self) -> io::Result<Connection> {
        match self {
            #[cfg(unix)]
            Self::UnixSocket(path) => Ok(Connection::Socket(
                tokio::net::UnixStream::connect(path).await?,
            )),
            Self::Command(spec) => Ok(Connection::Bridge(BridgeProcess::spawn(spec)?)),
        }
    }
}

impl Connector for Endpoint {
    type Link = Connection;

    fn open(&self) -> impl Future<Output = io::Result<Connection>> + Send {
        self.connect()
    }
}

pub enum Connection {
    #[cfg(unix)]
    Socket(tokio::net::UnixStream),
    Bridge(BridgeProcess),
}

impl Link for Connection {
    fn has_ended(&mut self) -> bool {
        match self {
            #[cfg(unix)]
            Self::Socket(_) => false,
            Self::Bridge(bridge) => bridge.has_exited(),
        }
    }

    async fn diagnose(self) -> Option<LinkFailure> {
        match self {
            #[cfg(unix)]
            Self::Socket(_) => None,
            Self::Bridge(bridge) => Some(bridge.finish().await.into()),
        }
    }
}

impl AsyncRead for Connection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Bridge(bridge) => Pin::new(bridge).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Connection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Bridge(bridge) => Pin::new(bridge).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_flush(cx),
            Self::Bridge(bridge) => Pin::new(bridge).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Bridge(bridge) => Pin::new(bridge).poll_shutdown(cx),
        }
    }
}
