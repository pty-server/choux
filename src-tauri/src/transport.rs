pub mod bridge;
pub mod exit;
pub mod http;
#[cfg(windows)]
mod job;
pub mod pool;
#[cfg(all(test, windows))]
mod process_tree;
#[cfg(all(test, unix))]
mod ptys_bridge_tests;
pub mod response;
pub mod target;
#[cfg(all(test, windows))]
mod wsl_bridge_tests;

use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_tungstenite::{
    client_async, tungstenite::handshake::client::Request as HandshakeRequest, WebSocketStream,
};

use bridge::{BridgePipes, BridgeProcess, CommandSpec};
use exit::BridgeExit;
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
            Self::UnixSocket(path) => Ok(Connection {
                stream: Stream::Socket(tokio::net::UnixStream::connect(path).await?),
                process: None,
            }),
            Self::Command(spec) => {
                let (pipes, process) = bridge::spawn(spec)?;
                Ok(Connection {
                    stream: Stream::Bridge(pipes),
                    process: Some(process),
                })
            }
        }
    }

    pub async fn open_websocket(&self, request: HandshakeRequest) -> Result<WebSocket, String> {
        let (stream, process) = self
            .connect()
            .await
            .map_err(|error| error.to_string())?
            .into_parts();
        match client_async(request, stream).await {
            Ok((stream, _)) => Ok(WebSocket { stream, process }),
            Err(error) => Err(match process {
                Some(process) => refused_handshake(error.to_string(), process.finish().await),
                None => error.to_string(),
            }),
        }
    }
}

fn refused_handshake(error: String, exit: BridgeExit) -> String {
    if exit.is_permanent() {
        exit.to_string()
    } else if exit.code == Some(0) {
        error
    } else {
        format!("{error} ({exit})")
    }
}

impl Connector for Endpoint {
    type Link = Connection;

    fn open(&self) -> impl Future<Output = io::Result<Connection>> + Send {
        self.connect()
    }
}

pub struct WebSocket {
    pub stream: WebSocketStream<Stream>,
    pub process: Option<BridgeProcess>,
}

pub enum Stream {
    #[cfg(unix)]
    Socket(tokio::net::UnixStream),
    Bridge(BridgePipes),
}

pub struct Connection {
    stream: Stream,
    process: Option<BridgeProcess>,
}

impl Connection {
    pub fn into_parts(self) -> (Stream, Option<BridgeProcess>) {
        (self.stream, self.process)
    }
}

impl Link for Connection {
    fn has_ended(&mut self) -> bool {
        self.process.as_mut().is_some_and(BridgeProcess::has_exited)
    }

    async fn diagnose(self) -> Option<LinkFailure> {
        let (stream, process) = self.into_parts();
        drop(stream);
        Some(process?.finish().await.into())
    }
}

impl AsyncRead for Connection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Connection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Bridge(pipes) => Pin::new(pipes).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Bridge(pipes) => Pin::new(pipes).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_flush(cx),
            Self::Bridge(pipes) => Pin::new(pipes).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            Self::Socket(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Bridge(pipes) => Pin::new(pipes).poll_shutdown(cx),
        }
    }
}
