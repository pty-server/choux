use std::{collections::HashMap, fmt, io};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::response::{ParseError, Response, ResponseParser};

const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy)]
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: &'a str,
    pub headers: &'a HashMap<String, String>,
    pub body: Option<&'a [u8]>,
    pub keep_alive: bool,
}

#[derive(Debug)]
pub enum HttpError {
    InvalidMethod,
    InvalidPath,
    InvalidHeader,
    NotReusable,
    NotSent(io::Error),
    Write(io::Error),
    Read(io::Error),
    ClosedBeforeResponse,
    InvalidResponse(ParseError),
}

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMethod => formatter.write_str("invalid request method"),
            Self::InvalidPath => formatter.write_str("invalid request path"),
            Self::InvalidHeader => formatter.write_str("invalid request header"),
            Self::NotSent(error) => write!(formatter, "could not send the request: {error}"),
            Self::NotReusable => formatter.write_str("the connection cannot carry another request"),
            Self::Write(error) => write!(formatter, "could not write the request: {error}"),
            Self::Read(error) => write!(formatter, "could not read the response: {error}"),
            Self::ClosedBeforeResponse => {
                formatter.write_str("the connection closed before a response")
            }
            Self::InvalidResponse(error) => write!(formatter, "invalid HTTP response: {error}"),
        }
    }
}

pub(super) fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

pub struct HttpConnection<S> {
    stream: S,
    parser: ResponseParser,
    reusable: bool,
}

impl<S: AsyncRead + AsyncWrite + Unpin> HttpConnection<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            parser: ResponseParser::default(),
            reusable: true,
        }
    }

    pub async fn send(&mut self, request: &Request<'_>) -> Result<Response, HttpError> {
        if !self.reusable {
            return Err(HttpError::NotReusable);
        }
        let mut message = request_head(request)?;
        message.extend_from_slice(request.body.unwrap_or_default());
        self.reusable = false;
        self.parser.expect_response_to(request.method);
        self.write_message(&message).await?;
        let response = self.read_response().await?;
        self.reusable = request.keep_alive && response.keep_alive;
        Ok(response)
    }

    async fn write_message(&mut self, message: &[u8]) -> Result<(), HttpError> {
        let mut written = 0;
        while written < message.len() {
            match self.stream.write(&message[written..]).await {
                Ok(0) => return Err(write_failure(written, io::ErrorKind::WriteZero.into())),
                Ok(count) => written += count,
                Err(error) => return Err(write_failure(written, error)),
            }
        }
        self.stream.flush().await.map_err(HttpError::Write)
    }

    async fn read_response(&mut self) -> Result<Response, HttpError> {
        let mut chunk = vec![0; READ_CHUNK_BYTES];
        loop {
            if let Some(response) = self.parser.parse().map_err(HttpError::InvalidResponse)? {
                return Ok(response);
            }
            let read = self
                .stream
                .read(&mut chunk)
                .await
                .map_err(HttpError::Read)?;
            if read == 0 {
                return self
                    .parser
                    .finish()
                    .map_err(HttpError::InvalidResponse)?
                    .ok_or(HttpError::ClosedBeforeResponse);
            }
            self.parser.feed(&chunk[..read]);
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
impl<S> HttpConnection<S> {
    pub fn is_reusable(&self) -> bool {
        self.reusable
    }

    pub fn stream_mut(&mut self) -> &mut S {
        &mut self.stream
    }

    pub fn into_stream(self) -> S {
        self.stream
    }
}

fn write_failure(written: usize, error: io::Error) -> HttpError {
    if written == 0 {
        HttpError::NotSent(error)
    } else {
        HttpError::Write(error)
    }
}

pub(super) fn request_head(request: &Request<'_>) -> Result<Vec<u8>, HttpError> {
    if !is_token(request.method) {
        return Err(HttpError::InvalidMethod);
    }
    if !request.path.starts_with('/')
        || request
            .path
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return Err(HttpError::InvalidPath);
    }
    let content_length = request.body.map(|body| body.len().to_string());
    let mut fields = vec![("Host", request.host)];
    if !request.keep_alive {
        fields.push(("Connection", "close"));
    }
    fields.extend(
        request
            .headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
    fields.extend(
        content_length
            .as_deref()
            .map(|length| ("Content-Length", length)),
    );

    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
    for (name, value) in fields {
        if !is_token(name) || value.contains(['\r', '\n', '\0']) {
            return Err(HttpError::InvalidHeader);
        }
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    Ok(head.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    fn get<'a>(path: &'a str, headers: &'a HashMap<String, String>) -> Request<'a> {
        Request {
            method: "GET",
            path,
            host: "ptys.local",
            headers,
            body: None,
            keep_alive: false,
        }
    }

    #[tokio::test]
    async fn writes_the_request_and_reads_a_chunked_response_split_across_reads() {
        let (client, mut server) = duplex(64);
        let headers = HashMap::from([("Content-Type".to_string(), "application/json".to_string())]);
        let expected: &[u8] = b"POST /v1/sessions HTTP/1.1\r\nHost: ptys.local\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let server_task = tokio::spawn(async move {
            let mut received = vec![0; expected.len()];
            server.read_exact(&mut received).await.unwrap();
            let response: &[u8] = b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
            let (first, second) = response.split_at(40);
            server.write_all(first).await.unwrap();
            server.write_all(second).await.unwrap();
            received
        });

        let mut connection = HttpConnection::new(client);
        let request = Request {
            method: "POST",
            body: Some(b"{}".as_slice()),
            ..get("/v1/sessions", &headers)
        };
        let response = connection.send(&request).await.unwrap();

        assert_eq!(server_task.await.unwrap(), expected);
        assert_eq!(
            (
                response.status,
                response.reason.as_str(),
                response.body.as_slice()
            ),
            (201, "Created", b"{\"a\":1}".as_slice())
        );
        assert!(matches!(
            connection.send(&request).await,
            Err(HttpError::NotReusable)
        ));
    }

    #[tokio::test]
    async fn carries_several_requests_on_a_kept_alive_connection() {
        let (client, mut server) = duplex(1024);
        let headers = HashMap::new();
        let request = Request {
            keep_alive: true,
            ..get("/v1/info", &headers)
        };
        let request_length = request_head(&request).unwrap().len();
        let server_task = tokio::spawn(async move {
            for body in ["one", "two"] {
                let mut received = vec![0; request_length];
                server.read_exact(&mut received).await.unwrap();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{body}");
                server.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let mut connection = HttpConnection::new(client);
        let first = connection.send(&request).await.unwrap();
        let second = connection.send(&request).await.unwrap();

        server_task.await.unwrap();
        assert_eq!(
            (first.body, second.body),
            (b"one".to_vec(), b"two".to_vec())
        );
    }

    #[tokio::test]
    async fn a_response_closing_the_connection_ends_its_reuse() {
        let (client, mut server) = duplex(1024);
        server
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let headers = HashMap::new();
        let request = Request {
            keep_alive: true,
            ..get("/v1/info", &headers)
        };

        let mut connection = HttpConnection::new(client);
        assert_eq!(connection.send(&request).await.unwrap().status, 204);
        assert!(matches!(
            connection.send(&request).await,
            Err(HttpError::NotReusable)
        ));
    }

    #[tokio::test]
    async fn rejects_an_invalid_request_without_writing_it() {
        let (client, mut server) = duplex(1024);
        let clean = HashMap::new();
        let injected = HashMap::from([("X-Test".to_string(), "a\r\nInjected: yes".to_string())]);
        let mut connection = HttpConnection::new(client);

        assert!(matches!(
            connection.send(&get("/v1\r\nInjected: yes", &clean)).await,
            Err(HttpError::InvalidPath)
        ));
        assert!(matches!(
            connection.send(&get("v1/info", &clean)).await,
            Err(HttpError::InvalidPath)
        ));
        assert!(matches!(
            connection
                .send(&Request {
                    method: "GET /x",
                    ..get("/v1", &clean)
                })
                .await,
            Err(HttpError::InvalidMethod)
        ));
        assert!(matches!(
            connection.send(&get("/v1", &injected)).await,
            Err(HttpError::InvalidHeader)
        ));

        drop(connection);
        let mut written = Vec::new();
        server.read_to_end(&mut written).await.unwrap();
        assert!(written.is_empty());
    }

    #[tokio::test]
    async fn reports_a_connection_closed_before_any_response() {
        let (client, mut server) = duplex(1024);
        let headers = HashMap::new();
        let request = get("/v1/info", &headers);
        let request_length = request_head(&request).unwrap().len();
        tokio::spawn(async move {
            let mut received = vec![0; request_length];
            server.read_exact(&mut received).await.unwrap();
        });

        assert!(matches!(
            HttpConnection::new(client).send(&request).await,
            Err(HttpError::ClosedBeforeResponse)
        ));
    }

    #[tokio::test]
    async fn reports_a_response_cut_off_by_the_close() {
        let (client, mut server) = duplex(1024);
        let headers = HashMap::new();
        let request = get("/v1/info", &headers);
        let request_length = request_head(&request).unwrap().len();
        tokio::spawn(async move {
            let mut received = vec![0; request_length];
            server.read_exact(&mut received).await.unwrap();
            server
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort")
                .await
                .unwrap();
        });

        assert!(matches!(
            HttpConnection::new(client).send(&request).await,
            Err(HttpError::InvalidResponse(ParseError::Truncated))
        ));
    }
}
