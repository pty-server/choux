use std::fmt;

use super::http::is_token;

const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub reason: String,
    pub body: Vec<u8>,
    pub keep_alive: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    HeadTooLarge,
    LineTooLong,
    InvalidStatusLine,
    InvalidHeader,
    InvalidContentLength,
    UnexpectedUpgrade,
    InvalidChunkSize,
    InvalidChunkDelimiter,
    Truncated,
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HeadTooLarge => "response headers are too large",
            Self::LineTooLong => "response line is too long",
            Self::InvalidStatusLine => "invalid status line",
            Self::InvalidHeader => "invalid header",
            Self::InvalidContentLength => "invalid Content-Length",
            Self::UnexpectedUpgrade => "unexpected protocol switch",
            Self::InvalidChunkSize => "invalid chunk size",
            Self::InvalidChunkDelimiter => "invalid chunk delimiter",
            Self::Truncated => "truncated response",
        })
    }
}

#[derive(Default)]
struct Head {
    status: u16,
    reason: String,
    keep_alive: bool,
}

#[derive(Clone, Copy, Default)]
enum Stage {
    #[default]
    Head,
    Sized {
        remaining: usize,
    },
    ChunkSize,
    ChunkData {
        remaining: usize,
    },
    ChunkEnd,
    Trailers,
    UntilEof,
}

#[derive(Default)]
pub struct ResponseParser {
    buffer: Vec<u8>,
    stage: Stage,
    head_request: bool,
    head: Head,
    body: Vec<u8>,
}

impl ResponseParser {
    pub fn expect_response_to(&mut self, method: &str) {
        self.head_request = method.eq_ignore_ascii_case("HEAD");
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    pub fn parse(&mut self) -> Result<Option<Response>, ParseError> {
        loop {
            match self.stage {
                Stage::Head => {
                    let Some(end) = position_within(
                        &self.buffer,
                        b"\r\n\r\n",
                        MAX_HEAD_BYTES,
                        ParseError::HeadTooLarge,
                    )?
                    else {
                        return Ok(None);
                    };
                    let (head, stage) = parse_head(&self.buffer[..end], self.head_request)?;
                    self.buffer.drain(..end + 4);
                    match head.status {
                        101 => return Err(ParseError::UnexpectedUpgrade),
                        100..=199 => continue,
                        _ => {}
                    }
                    self.head = head;
                    self.stage = stage;
                }
                Stage::Sized { remaining } => {
                    let remaining = self.take_body(remaining);
                    if remaining > 0 {
                        self.stage = Stage::Sized { remaining };
                        return Ok(None);
                    }
                    return Ok(Some(self.complete()));
                }
                Stage::ChunkSize => {
                    let Some(line) = self.take_line()? else {
                        return Ok(None);
                    };
                    self.stage = match parse_chunk_size(&line)? {
                        0 => Stage::Trailers,
                        remaining => Stage::ChunkData { remaining },
                    };
                }
                Stage::ChunkData { remaining } => {
                    let remaining = self.take_body(remaining);
                    if remaining > 0 {
                        self.stage = Stage::ChunkData { remaining };
                        return Ok(None);
                    }
                    self.stage = Stage::ChunkEnd;
                }
                Stage::ChunkEnd => {
                    if self.buffer.len() < 2 {
                        return Ok(None);
                    }
                    if !self.buffer.starts_with(b"\r\n") {
                        return Err(ParseError::InvalidChunkDelimiter);
                    }
                    self.buffer.drain(..2);
                    self.stage = Stage::ChunkSize;
                }
                Stage::Trailers => {
                    let Some(line) = self.take_line()? else {
                        return Ok(None);
                    };
                    if line.is_empty() {
                        return Ok(Some(self.complete()));
                    }
                }
                Stage::UntilEof => {
                    self.body.append(&mut self.buffer);
                    return Ok(None);
                }
            }
        }
    }

    pub fn finish(&mut self) -> Result<Option<Response>, ParseError> {
        if let Some(response) = self.parse()? {
            return Ok(Some(response));
        }
        match self.stage {
            Stage::UntilEof => Ok(Some(self.complete())),
            Stage::Head if self.buffer.is_empty() => Ok(None),
            _ => Err(ParseError::Truncated),
        }
    }

    fn take_body(&mut self, remaining: usize) -> usize {
        let taken = remaining.min(self.buffer.len());
        self.body.extend(self.buffer.drain(..taken));
        remaining - taken
    }

    fn take_line(&mut self) -> Result<Option<Vec<u8>>, ParseError> {
        let Some(end) = position_within(
            &self.buffer,
            b"\r\n",
            MAX_LINE_BYTES,
            ParseError::LineTooLong,
        )?
        else {
            return Ok(None);
        };
        let line = self.buffer[..end].to_vec();
        self.buffer.drain(..end + 2);
        Ok(Some(line))
    }

    fn complete(&mut self) -> Response {
        let head = std::mem::take(&mut self.head);
        self.stage = Stage::Head;
        Response {
            status: head.status,
            reason: head.reason,
            body: std::mem::take(&mut self.body),
            keep_alive: head.keep_alive,
        }
    }
}

fn position_within(
    buffer: &[u8],
    delimiter: &[u8],
    limit: usize,
    exceeded: ParseError,
) -> Result<Option<usize>, ParseError> {
    let searched = &buffer[..buffer.len().min(limit + delimiter.len())];
    match searched
        .windows(delimiter.len())
        .position(|window| window == delimiter)
    {
        Some(position) => Ok(Some(position)),
        None if searched.len() == limit + delimiter.len() => Err(exceeded),
        None => Ok(None),
    }
}

fn parse_head(bytes: &[u8], head_request: bool) -> Result<(Head, Stage), ParseError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ParseError::InvalidHeader)?;
    let mut lines = text.split("\r\n");
    let mut status_line = lines.next().unwrap_or_default().splitn(3, ' ');
    let http_1_1 = match status_line.next() {
        Some("HTTP/1.1") => true,
        Some("HTTP/1.0") => false,
        _ => return Err(ParseError::InvalidStatusLine),
    };
    let status = status_line
        .next()
        .filter(|code| code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|code| code.parse::<u16>().ok())
        .filter(|status| *status >= 100)
        .ok_or(ParseError::InvalidStatusLine)?;
    let reason = status_line.next().unwrap_or_default().to_owned();
    let headers = lines
        .map(|line| match line.split_once(':') {
            Some((name, value)) if is_token(name) => Ok((name, value.trim_matches([' ', '\t']))),
            _ => Err(ParseError::InvalidHeader),
        })
        .collect::<Result<Vec<_>, _>>()?;

    let stage = if head_request || status == 204 || status == 304 {
        Stage::Sized { remaining: 0 }
    } else if let Some(last_coding) = header_tokens(&headers, "transfer-encoding").last() {
        if last_coding == "chunked" {
            Stage::ChunkSize
        } else {
            Stage::UntilEof
        }
    } else {
        match content_length(&headers)? {
            Some(remaining) => Stage::Sized { remaining },
            None => Stage::UntilEof,
        }
    };
    let connection = header_tokens(&headers, "connection");
    let persistent = if http_1_1 {
        !connection.iter().any(|token| token == "close")
    } else {
        connection.iter().any(|token| token == "keep-alive")
    };
    let head = Head {
        status,
        reason,
        keep_alive: persistent && !matches!(stage, Stage::UntilEof),
    };
    Ok((head, stage))
}

fn header_tokens(headers: &[(&str, &str)], name: &str) -> Vec<String> {
    headers
        .iter()
        .filter(|(header, _)| header.eq_ignore_ascii_case(name))
        .flat_map(|(_, value)| value.split(','))
        .map(|token| token.trim_matches([' ', '\t']).to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn content_length(headers: &[(&str, &str)]) -> Result<Option<usize>, ParseError> {
    let mut length = None;
    for token in header_tokens(headers, "content-length") {
        let parsed = Some(token.as_str())
            .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|digits| digits.parse::<usize>().ok())
            .ok_or(ParseError::InvalidContentLength)?;
        if length.is_some_and(|existing| existing != parsed) {
            return Err(ParseError::InvalidContentLength);
        }
        length = Some(parsed);
    }
    Ok(length)
}

fn parse_chunk_size(line: &[u8]) -> Result<usize, ParseError> {
    let size = line.split(|byte| *byte == b';').next().unwrap_or_default();
    let size = std::str::from_utf8(size)
        .map_err(|_| ParseError::InvalidChunkSize)?
        .trim_matches([' ', '\t']);
    if size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ParseError::InvalidChunkSize);
    }
    usize::from_str_radix(size, 16).map_err(|_| ParseError::InvalidChunkSize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_in_pieces(raw: &[u8], piece: usize) -> Result<Option<Response>, ParseError> {
        let mut parser = ResponseParser::default();
        for part in raw.chunks(piece) {
            parser.feed(part);
            if let Some(response) = parser.parse()? {
                return Ok(Some(response));
            }
        }
        parser.finish()
    }

    fn parse_whole(raw: &[u8]) -> Response {
        parse_in_pieces(raw, raw.len())
            .expect("valid response")
            .expect("complete response")
    }

    #[test]
    fn reads_a_body_sized_by_content_length() {
        let response = parse_whole(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
        assert_eq!(
            response,
            Response {
                status: 200,
                reason: "OK".into(),
                body: b"hello".to_vec(),
                keep_alive: true,
            }
        );
    }

    #[test]
    fn decodes_chunks_with_extensions_and_trailers_at_every_piece_size() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;name=value\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: yes\r\n\r\n";
        for piece in 1..=raw.len() {
            let response = parse_in_pieces(raw, piece).unwrap().unwrap();
            assert_eq!(response.body, b"hello world", "piece size {piece}");
            assert!(response.keep_alive);
        }
    }

    #[test]
    fn ignores_the_framing_of_bodyless_responses() {
        let cases: [(&str, &[u8]); 3] = [
            (
                "GET",
                b"HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n",
            ),
            (
                "GET",
                b"HTTP/1.1 304 Not Modified\r\nTransfer-Encoding: chunked\r\n\r\n",
            ),
            ("HEAD", b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n"),
        ];
        for (method, raw) in cases {
            let mut parser = ResponseParser::default();
            parser.expect_response_to(method);
            parser.feed(raw);
            let response = parser.parse().unwrap().expect("complete response");
            assert!(response.body.is_empty());
            assert!(response.keep_alive);
        }
    }

    #[test]
    fn keeps_bytes_after_a_response_for_the_next_one() {
        let mut parser = ResponseParser::default();
        parser.feed(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\noneHTTP/1.1 201 Created\r\nContent-Length: 3\r\n\r\ntwo");
        let first = parser.parse().unwrap().unwrap();
        parser.expect_response_to("GET");
        let second = parser.parse().unwrap().unwrap();
        assert_eq!((first.status, first.body), (200, b"one".to_vec()));
        assert_eq!((second.status, second.body), (201, b"two".to_vec()));
        assert_eq!(parser.parse(), Ok(None));
    }

    #[test]
    fn follows_the_connection_header_and_http_version() {
        let cases: [(&[u8], bool); 4] = [
            (
                b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                false,
            ),
            (
                b"HTTP/1.1 200 OK\r\nconnection: Upgrade, Close\r\nContent-Length: 0\r\n\r\n",
                false,
            ),
            (b"HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", false),
            (
                b"HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n",
                true,
            ),
        ];
        for (raw, keep_alive) in cases {
            assert_eq!(parse_whole(raw).keep_alive, keep_alive);
        }
    }

    #[test]
    fn reads_an_unframed_body_until_the_connection_closes() {
        for head in [
            &b"HTTP/1.1 200 OK\r\n\r\n"[..],
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n",
        ] {
            let mut parser = ResponseParser::default();
            parser.feed(head);
            parser.feed(b"part one, ");
            assert_eq!(parser.parse(), Ok(None));
            parser.feed(b"part two");
            let response = parser.finish().unwrap().unwrap();
            assert_eq!(response.body, b"part one, part two");
            assert!(!response.keep_alive);
        }
    }

    #[test]
    fn tells_a_silent_close_from_a_truncated_response() {
        assert_eq!(ResponseParser::default().finish(), Ok(None));
        for raw in [
            &b"HTTP/1.1 200 OK\r\nContent-Le"[..],
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
        ] {
            let mut parser = ResponseParser::default();
            parser.feed(raw);
            assert_eq!(parser.parse(), Ok(None));
            assert_eq!(parser.finish(), Err(ParseError::Truncated));
        }
    }

    #[test]
    fn skips_interim_responses() {
        let response = parse_whole(
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
        );
        assert_eq!((response.status, response.body), (200, b"ok".to_vec()));
    }

    #[test]
    fn rejects_malformed_responses() {
        let cases: [(&[u8], ParseError); 9] = [
            (b"HTTP/2 200 OK\r\n\r\n", ParseError::InvalidStatusLine),
            (b"HTTP/1.1 20 OK\r\n\r\n", ParseError::InvalidStatusLine),
            (
                b"HTTP/1.1 200 OK\r\n folded: header\r\n\r\n",
                ParseError::InvalidHeader,
            ),
            (
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n",
                ParseError::InvalidContentLength,
            ),
            (
                b"HTTP/1.1 200 OK\r\nContent-Length: +5\r\n\r\n",
                ParseError::InvalidContentLength,
            ),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
                ParseError::InvalidChunkSize,
            ),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n+2\r\n",
                ParseError::InvalidChunkSize,
            ),
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nokX\r\n",
                ParseError::InvalidChunkDelimiter,
            ),
            (
                b"HTTP/1.1 101 Switching Protocols\r\n\r\n",
                ParseError::UnexpectedUpgrade,
            ),
        ];
        for (raw, error) in cases {
            let mut parser = ResponseParser::default();
            parser.feed(raw);
            assert_eq!(parser.parse(), Err(error));
        }
    }

    #[test]
    fn bounds_the_head_and_protocol_lines() {
        let mut parser = ResponseParser::default();
        parser.feed(b"HTTP/1.1 200 OK\r\n");
        parser.feed(&vec![b'a'; MAX_HEAD_BYTES]);
        assert_eq!(parser.parse(), Err(ParseError::HeadTooLarge));

        let mut parser = ResponseParser::default();
        parser.feed(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        parser.feed(&vec![b'1'; MAX_LINE_BYTES + 2]);
        assert_eq!(parser.parse(), Err(ParseError::LineTooLong));
    }
}
