//! Bookmarks read from a file another browser wrote: Chrome's own `Bookmarks`
//! JSON, or the HTML file every browser exports. The result feeds a group's
//! bookmark list, or the one every profile gets; nothing is stored here.

use crate::group_bookmarks::GroupBookmark;
use serde_json::Value;

/// More than this is not a bookmark bar.
const MAX_BOOKMARKS: usize = 2000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

fn http(url: &str) -> bool {
  let lower = url.trim().to_ascii_lowercase();
  lower.starts_with("http://") || lower.starts_with("https://")
}

fn push(out: &mut Vec<GroupBookmark>, title: &str, url: &str, folders: &[String]) {
  let url = url.trim();
  if !http(url) || out.len() >= MAX_BOOKMARKS || out.iter().any(|b| b.url == url) {
    return;
  }
  let title = title.trim();
  out.push(GroupBookmark {
    title: if title.is_empty() { url } else { title }.to_string(),
    url: url.to_string(),
    folder: (!folders.is_empty()).then(|| folders.join(" / ")),
  });
}

fn walk_json(node: &Value, folders: &mut Vec<String>, out: &mut Vec<GroupBookmark>) {
  match node.get("type").and_then(Value::as_str) {
    Some("url") => push(
      out,
      node.get("name").and_then(Value::as_str).unwrap_or_default(),
      node.get("url").and_then(Value::as_str).unwrap_or_default(),
      folders,
    ),
    Some("folder") => {
      let name = node
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
      let named = !name.is_empty();
      if named {
        folders.push(name);
      }
      for child in node
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
      {
        walk_json(child, folders, out);
      }
      if named {
        folders.pop();
      }
    }
    _ => {}
  }
}

/// Chrome's `Bookmarks` file. The roots (bar, other, mobile) are not folders
/// a person made, so their names are left out.
fn parse_chrome_json(root: &Value) -> Option<Vec<GroupBookmark>> {
  let roots = root.get("roots")?.as_object()?;
  let mut out = Vec::new();
  for key in ["bookmark_bar", "other", "synced"] {
    for child in roots
      .get(key)
      .and_then(|r| r.get("children"))
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
    {
      walk_json(child, &mut Vec::new(), &mut out);
    }
  }
  Some(out)
}

fn decode_entities(text: &str) -> String {
  text
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&#x27;", "'")
    .replace("&amp;", "&")
}

fn attribute(tag: &str, name: &str) -> Option<String> {
  let lower = tag.to_ascii_lowercase();
  let at = lower.find(&format!("{name}=\""))? + name.len() + 2;
  let end = tag[at..].find('"')? + at;
  Some(decode_entities(&tag[at..end]))
}

/// The HTML bookmarks file browsers export: `<H3>` names a folder, the `<DL>`
/// after it holds its entries, `<A HREF>` is a bookmark.
fn parse_html(html: &str) -> Vec<GroupBookmark> {
  let mut out = Vec::new();
  let mut folders: Vec<String> = Vec::new();
  // Each open <DL> remembers whether it opened a named folder.
  let mut lists: Vec<bool> = Vec::new();
  let mut pending_folder: Option<String> = None;
  let mut rest = html;
  while let Some(open) = rest.find('<') {
    rest = &rest[open..];
    let Some(close) = rest.find('>') else { break };
    let tag = &rest[1..close];
    let name = tag
      .trim_start_matches('/')
      .split(|c: char| c.is_whitespace())
      .next()
      .unwrap_or_default()
      .to_ascii_lowercase();
    let after = &rest[close + 1..];
    let text_until = |end: &str| {
      after
        .to_ascii_lowercase()
        .find(end)
        .map(|i| decode_entities(&after[..i]))
        .unwrap_or_default()
    };
    match (tag.starts_with('/'), name.as_str()) {
      (false, "h3") => pending_folder = Some(text_until("</h3>").trim().to_string()),
      (false, "dl") => {
        let folder = pending_folder.take().filter(|f| !f.is_empty());
        lists.push(folder.is_some());
        if let Some(folder) = folder {
          folders.push(folder);
        }
      }
      (true, "dl") => {
        if lists.pop() == Some(true) {
          folders.pop();
        }
      }
      (false, "a") => {
        if let Some(href) = attribute(tag, "href") {
          push(&mut out, &text_until("</a>"), &href, &folders);
        }
      }
      _ => {}
    }
    rest = after;
  }
  out
}

pub fn parse_bookmarks(content: &str) -> Result<Vec<GroupBookmark>, String> {
  let trimmed = content.trim_start_matches('\u{feff}').trim_start();
  let parsed = if trimmed.starts_with('{') {
    serde_json::from_str::<Value>(trimmed)
      .ok()
      .and_then(|root| parse_chrome_json(&root))
  } else if trimmed.to_ascii_lowercase().contains("<a ") {
    Some(parse_html(trimmed))
  } else {
    None
  };
  parsed.ok_or_else(|| crate::backend_error("BOOKMARKS_FILE_INVALID"))
}

/// The bookmarks in a file the person picked.
#[tauri::command]
pub async fn read_bookmarks_file(path: String) -> Result<Vec<GroupBookmark>, String> {
  let path = std::path::PathBuf::from(path);
  let too_big = std::fs::metadata(&path)
    .map(|m| m.len() > MAX_FILE_BYTES)
    .map_err(|_| crate::backend_error("BOOKMARKS_FILE_INVALID"))?;
  if too_big {
    return Err(crate::backend_error("BOOKMARKS_FILE_INVALID"));
  }
  let bytes = std::fs::read(&path).map_err(|_| crate::backend_error("BOOKMARKS_FILE_INVALID"))?;
  parse_bookmarks(&String::from_utf8_lossy(&bytes))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chrome_json_keeps_folders_and_drops_other_schemes() {
    let json = r#"{"roots":{
      "bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[
        {"type":"url","name":"Mail","url":"https://mail.example"},
        {"type":"folder","name":"Work","children":[
          {"type":"url","name":"Docs","url":"https://docs.example/a"},
          {"type":"url","name":"Script","url":"javascript:alert(1)"}
        ]}
      ]},
      "other":{"type":"folder","name":"Other","children":[
        {"type":"url","name":"","url":"https://mail.example"},
        {"type":"url","name":"","url":"http://plain.example"}
      ]}
    }}"#;
    let found = parse_bookmarks(json).unwrap();
    let flat: Vec<_> = found
      .iter()
      .map(|b| (b.title.as_str(), b.url.as_str(), b.folder.as_deref()))
      .collect();
    assert_eq!(
      flat,
      [
        ("Mail", "https://mail.example", None),
        ("Docs", "https://docs.example/a", Some("Work")),
        ("http://plain.example", "http://plain.example", None),
      ]
    );
  }

  #[test]
  fn html_export_nests_folders() {
    let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1">Shops</H3>
  <DL><p>
    <DT><A HREF="https://shop.example/?a=1&amp;b=2">Shop &amp; Co</A>
    <DT><H3>EU</H3>
    <DL><p><DT><A HREF="https://eu.example">EU</A></DL><p>
  </DL><p>
  <DT><A HREF="https://top.example">Top</A>
</DL>"#;
    let found = parse_bookmarks(html).unwrap();
    let flat: Vec<_> = found
      .iter()
      .map(|b| (b.title.as_str(), b.url.as_str(), b.folder.as_deref()))
      .collect();
    assert_eq!(
      flat,
      [
        ("Shop & Co", "https://shop.example/?a=1&b=2", Some("Shops")),
        ("EU", "https://eu.example", Some("Shops / EU")),
        ("Top", "https://top.example", None),
      ]
    );
  }

  #[test]
  fn other_files_are_refused() {
    assert!(parse_bookmarks("hello").is_err());
    assert!(parse_bookmarks("{\"a\":1}").is_err());
  }
}
