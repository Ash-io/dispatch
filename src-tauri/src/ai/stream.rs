//! Reading streamed answers: server-sent events (Anthropic, OpenAI) and
//! newline-delimited JSON (Ollama), split safely across UTF-8 chunk borders.

use std::sync::Arc;
use tokio::sync::Notify;

/// What to do after handling one event.
pub enum Flow {
    More,
    Done,
}

/// Calls `on_line` for each complete line of the body, without the newline.
pub async fn lines(mut resp: reqwest::Response, cancel: Arc<Notify>, mut on_line: impl FnMut(&str) -> Result<Flow, String>) -> Result<(), String> {
    let mut buf = String::new();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            c = resp.chunk() => c.map_err(|e| format!("The answer was cut off: {e}"))?,
            _ = cancel.notified() => return Err("Stopped.".into()),
        };
        let Some(chunk) = chunk else { break };
        pending.extend_from_slice(&chunk);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        buf.push_str(&String::from_utf8_lossy(&pending[..valid]));
        pending.drain(..valid);
        while let Some(end) = buf.find('\n') {
            let line: String = buf.drain(..=end).collect();
            if let Flow::Done = on_line(line.trim_end_matches(['\n', '\r']))? {
                return Ok(());
            }
        }
    }
    if !buf.is_empty() {
        on_line(buf.trim_end_matches('\r'))?;
    }
    Ok(())
}

/// Server-sent events: calls `on_data` with each event's joined `data:` lines.
pub async fn sse(resp: reqwest::Response, cancel: Arc<Notify>, mut on_data: impl FnMut(&str) -> Result<Flow, String>) -> Result<(), String> {
    let mut data: Vec<String> = Vec::new();
    let mut flush = |data: &mut Vec<String>| -> Result<Flow, String> {
        if data.is_empty() {
            return Ok(Flow::More);
        }
        let joined = data.join("\n");
        data.clear();
        on_data(&joined)
    };
    let mut done = false;
    lines(resp, cancel, |line| {
        if line.is_empty() {
            let flow = flush(&mut data)?;
            done = matches!(flow, Flow::Done);
            return Ok(flow);
        }
        if let Some(d) = line.strip_prefix("data:") {
            data.push(d.strip_prefix(' ').unwrap_or(d).to_string());
        }
        Ok(Flow::More)
    })
    .await?;
    if !done {
        flush(&mut data)?;
    }
    Ok(())
}

#[cfg(test)]
pub mod testing {
    use std::io::{Read, Write};
    use std::time::Duration;

    /// One-shot server replying with a canned body; returns the request it saw.
    pub fn server(content_type: &'static str, status: u16, body: String) -> (String, std::sync::mpsc::Receiver<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 8192];
            s.set_read_timeout(Some(Duration::from_millis(300))).ok();
            while let Ok(n) = s.read(&mut buf) {
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got);
                // Stop once the headers (and, for POSTs, a JSON body) have arrived.
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if got.len() >= head_end + 4 + len {
                        break;
                    }
                }
            }
            tx.send(String::from_utf8_lossy(&got).to_string()).ok();
            let reason = if status == 200 { "OK" } else { "Error" };
            s.write_all(format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        });
        (format!("http://{addr}"), rx)
    }
}
