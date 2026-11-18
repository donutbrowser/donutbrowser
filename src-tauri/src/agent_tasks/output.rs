//! Structured output: a routine names columns, its prompt asks for one JSON
//! object with those keys, and each run reports the object it got as `data`.
//! The cloud keeps the rows; a batch reads back as a table or a CSV file.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_COLUMNS: usize = 20;
const MAX_COLUMN_NAME_CHARS: usize = 60;
/// The largest `data` object the cloud takes.
const MAX_DATA_BYTES: usize = 32 * 1024;
const MAX_VALUE_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
  #[default]
  Text,
  Number,
  Bool,
  Url,
}

impl ColumnKind {
  /// How the prompt names the kind.
  pub fn words(self) -> &'static str {
    match self {
      Self::Text => "text",
      Self::Number => "number",
      Self::Bool => "true or false",
      Self::Url => "a web address",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
  pub name: String,
  #[serde(rename = "type", default)]
  pub kind: ColumnKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Output {
  #[serde(default)]
  pub columns: Vec<Column>,
}

/// The columns trimmed, named once each and at most `MAX_COLUMNS`; none is
/// no output at all.
pub fn checked(output: Option<Output>) -> Result<Option<Output>, String> {
  let Some(output) = output else {
    return Ok(None);
  };
  if output.columns.len() > MAX_COLUMNS {
    return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
  }
  let mut columns: Vec<Column> = Vec::with_capacity(output.columns.len());
  for column in output.columns {
    let name = column.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_COLUMN_NAME_CHARS {
      return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
    }
    if columns
      .iter()
      .any(|seen| seen.name.eq_ignore_ascii_case(&name))
    {
      return Err(crate::backend_error("AGENT_COLUMN_DUPLICATE"));
    }
    columns.push(Column {
      name,
      kind: column.kind,
    });
  }
  Ok((!columns.is_empty()).then_some(Output { columns }))
}

fn cut(text: &str) -> String {
  text.chars().take(MAX_VALUE_CHARS).collect()
}

fn number(value: &Value) -> Value {
  match value {
    Value::Number(_) => value.clone(),
    Value::String(text) => text
      .trim()
      .replace([',', ' '], "")
      .parse::<f64>()
      .ok()
      .filter(|n| n.is_finite())
      .map_or(Value::Null, Value::from),
    _ => Value::Null,
  }
}

fn boolean(value: &Value) -> Value {
  match value {
    Value::Bool(_) => value.clone(),
    Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
      "true" | "yes" | "y" | "1" => Value::Bool(true),
      "false" | "no" | "n" | "0" => Value::Bool(false),
      _ => Value::Null,
    },
    Value::Number(n) => n.as_f64().map_or(Value::Null, |n| Value::Bool(n != 0.0)),
    _ => Value::Null,
  }
}

fn coerce(value: &Value, kind: ColumnKind) -> Value {
  match (kind, value) {
    (_, Value::Null) => Value::Null,
    (ColumnKind::Number, _) => number(value),
    (ColumnKind::Bool, _) => boolean(value),
    (ColumnKind::Url, Value::String(text)) if super::cloud::is_web_url(text.trim()) => {
      Value::from(cut(text.trim()))
    }
    (ColumnKind::Url, _) => Value::Null,
    (ColumnKind::Text, Value::String(text)) => Value::from(cut(text)),
    (ColumnKind::Text, other) => Value::from(cut(&other.to_string())),
  }
}

/// The answer's object as the columns say: each column once, by its own
/// name, of its own kind, `null` where the answer had nothing. Without
/// columns, the object as it came. Never more than the cloud takes.
pub fn fit(object: &Map<String, Value>, columns: &[Column]) -> Map<String, Value> {
  let mut out = Map::new();
  if columns.is_empty() {
    for (key, value) in object.iter().take(MAX_COLUMNS) {
      out.insert(cut(key), coerce(value, ColumnKind::Text));
    }
  } else {
    for column in columns {
      let value = object
        .get(&column.name)
        .or_else(|| {
          object
            .iter()
            .find(|(key, _)| key.trim().eq_ignore_ascii_case(&column.name))
            .map(|(_, value)| value)
        })
        .unwrap_or(&Value::Null);
      out.insert(column.name.clone(), coerce(value, column.kind));
    }
  }
  while serde_json::to_vec(&out).map_or(0, |bytes| bytes.len()) > MAX_DATA_BYTES {
    let Some(longest) = out
      .iter()
      .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.len())))
      .max_by_key(|(_, len)| *len)
      .map(|(key, _)| key)
    else {
      break;
    };
    out.insert(longest, Value::Null);
  }
  out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
  pub run_id: String,
  #[serde(default)]
  pub profile_id: Option<String>,
  #[serde(default)]
  pub status: String,
  #[serde(default)]
  pub finished_at: Option<String>,
  #[serde(default)]
  pub data: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Table {
  /// The batch the rows are of; none when the routine has not run.
  #[serde(default)]
  pub batch_id: Option<String>,
  #[serde(default)]
  pub columns: Vec<Column>,
  #[serde(default)]
  pub rows: Vec<TableRow>,
}

fn table_url(routine_id: &str, resource: &str, batch_id: Option<&str>) -> Result<String, String> {
  let id = super::cloud::segment(routine_id, "AGENT_ROUTINE_NOT_FOUND")?;
  let mut url = format!("{}/routines/{id}/{resource}", super::cloud::base());
  if let Some(batch) = batch_id.map(str::trim).filter(|b| !b.is_empty()) {
    url.push_str("?batchId=");
    url.push_str(&urlencoding::encode(batch));
  }
  Ok(url)
}

/// One CSV field, quoted when it must be.
fn csv_field(text: &str) -> String {
  // A cell that starts like a formula would run as one in a spreadsheet.
  let text = if text.starts_with(['=', '+', '-', '@']) && text.parse::<f64>().is_err() {
    format!("'{text}")
  } else {
    text.to_string()
  };
  if text.contains([',', '"', '\n', '\r']) {
    format!("\"{}\"", text.replace('"', "\"\""))
  } else {
    text
  }
}

fn cell(value: Option<&Value>) -> String {
  match value {
    None | Some(Value::Null) => String::new(),
    Some(Value::String(text)) => text.clone(),
    Some(other) => other.to_string(),
  }
}

/// A table as CSV: profile, status, finished, then the columns.
pub fn to_csv(table: &Table, profile_name: impl Fn(&str) -> String) -> String {
  let mut lines = Vec::with_capacity(table.rows.len() + 1);
  let mut head = vec!["profile".to_string(), "status".into(), "finished_at".into()];
  head.extend(table.columns.iter().map(|c| csv_field(&c.name)));
  lines.push(head.join(","));
  for row in &table.rows {
    let mut fields = vec![
      csv_field(
        &row
          .profile_id
          .as_deref()
          .map(&profile_name)
          .unwrap_or_default(),
      ),
      csv_field(&row.status),
      csv_field(row.finished_at.as_deref().unwrap_or_default()),
    ];
    fields.extend(
      table
        .columns
        .iter()
        .map(|column| csv_field(&cell(row.data.get(&column.name)))),
    );
    lines.push(fields.join(","));
  }
  let mut csv = lines.join("\r\n");
  csv.push_str("\r\n");
  csv
}

pub async fn table(routine_id: &str, batch_id: Option<&str>) -> Result<Table, String> {
  let url = table_url(routine_id, "table", batch_id)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    let _ = url;
    return super::mock::table(routine_id, batch_id);
  }
  super::cloud::call("table", reqwest::Method::GET, url, None).await
}

#[tauri::command]
pub async fn get_agent_routine_table(
  id: String,
  batch_id: Option<String>,
) -> Result<Table, String> {
  super::ensure_entitled().await?;
  table(&id, batch_id.as_deref()).await
}

/// The batch's table written to `path` as CSV. Profiles go by their names
/// on this device, so the file reads without Donut. Returns the rows.
#[tauri::command]
pub async fn export_agent_routine_table(
  id: String,
  batch_id: Option<String>,
  path: String,
) -> Result<u64, String> {
  super::ensure_entitled().await?;
  let table = table(&id, batch_id.as_deref()).await?;
  let names: std::collections::HashMap<String, String> = crate::profile::ProfileManager::instance()
    .list_profiles()
    .map(|profiles| {
      profiles
        .into_iter()
        .map(|profile| (profile.id.to_string(), profile.name))
        .collect()
    })
    .unwrap_or_default();
  let csv = to_csv(&table, |id| {
    names.get(id).cloned().unwrap_or_else(|| id.to_string())
  });
  std::fs::write(&path, csv.as_bytes())
    .map_err(|e| crate::backend_error_with_detail("AGENT_EXPORT_FAILED", e))?;
  let rows = table.rows.len() as u64;
  log::info!("Agent routine table exported routine={id} rows={rows}");
  Ok(rows)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn columns() -> Vec<Column> {
    vec![
      Column {
        name: "Orders".into(),
        kind: ColumnKind::Number,
      },
      Column {
        name: "Paid".into(),
        kind: ColumnKind::Bool,
      },
      Column {
        name: "Page".into(),
        kind: ColumnKind::Url,
      },
      Column {
        name: "Note".into(),
        kind: ColumnKind::Text,
      },
    ]
  }

  #[test]
  fn an_answer_fits_the_columns() {
    let object = json!({ "orders": "1,204", "PAID": "yes", "Page": "javascript:alert(1)", "Note": 7, "Other": 1 });
    let data = fit(object.as_object().unwrap(), &columns());
    assert_eq!(
      Value::Object(data),
      json!({ "Orders": 1204.0, "Paid": true, "Page": null, "Note": "7" })
    );
    let missing = fit(&Map::new(), &columns());
    assert!(missing.values().all(Value::is_null));
    assert_eq!(missing.len(), 4);
  }

  #[test]
  fn data_never_outgrows_what_the_cloud_takes() {
    let columns: Vec<Column> = (0..20)
      .map(|i| Column {
        name: format!("C{i}"),
        kind: ColumnKind::Text,
      })
      .collect();
    let object: Map<String, Value> = (0..20)
      .map(|i| (format!("C{i}"), Value::from("é".repeat(5_000))))
      .collect();
    let data = fit(&object, &columns);
    assert!(serde_json::to_vec(&data).unwrap().len() <= MAX_DATA_BYTES);
    assert_eq!(data.len(), 20);
  }

  #[test]
  fn columns_are_checked_before_they_are_sent() {
    let named = |names: &[&str]| Output {
      columns: names
        .iter()
        .map(|name| Column {
          name: name.to_string(),
          kind: ColumnKind::Text,
        })
        .collect(),
    };
    assert_eq!(checked(None).unwrap(), None);
    assert_eq!(checked(Some(named(&[]))).unwrap(), None);
    assert_eq!(
      checked(Some(named(&[" Orders "])))
        .unwrap()
        .unwrap()
        .columns[0]
        .name,
      "Orders"
    );
    assert!(checked(Some(named(&["A", "a"])))
      .unwrap_err()
      .contains("AGENT_COLUMN_DUPLICATE"));
    assert!(checked(Some(named(&[" "])))
      .unwrap_err()
      .contains("AGENT_ROUTINE_INVALID"));
    let too_many: Vec<String> = (0..=MAX_COLUMNS).map(|i| format!("C{i}")).collect();
    let refs: Vec<&str> = too_many.iter().map(String::as_str).collect();
    assert!(checked(Some(named(&refs))).is_err());
  }

  #[test]
  fn a_table_reads_as_csv_with_names_and_safe_cells() {
    let table = Table {
      batch_id: Some("b1".into()),
      columns: columns(),
      rows: vec![TableRow {
        run_id: "r1".into(),
        profile_id: Some("p1".into()),
        status: "done".into(),
        finished_at: Some("2026-11-18T09:00:00Z".into()),
        data:
          json!({ "Orders": 3, "Paid": false, "Page": null, "Note": "=HYPERLINK(\"x\"), \"y\"" })
            .as_object()
            .unwrap()
            .clone(),
      }],
    };
    let csv = to_csv(&table, |_| "Store, EU".to_string());
    let lines: Vec<&str> = csv.split("\r\n").collect();
    assert_eq!(lines[0], "profile,status,finished_at,Orders,Paid,Page,Note");
    assert_eq!(
      lines[1],
      "\"Store, EU\",done,2026-11-18T09:00:00Z,3,false,,\"'=HYPERLINK(\"\"x\"\"), \"\"y\"\"\""
    );
  }
}
