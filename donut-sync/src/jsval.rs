//! Request bodies read the way the original server read them.
//!
//! The server never validated its request bodies: it read fields straight off
//! the parsed JSON and let JavaScript coerce them. A missing body made a field
//! read throw, a missing field read as `undefined`, and template strings turned
//! any value into text. These helpers keep those outcomes, so a client that
//! sends something unexpected gets the answer it always got.

use serde_json::Value;

/// A field read off a request body.
#[derive(Clone, Copy, Debug)]
pub enum Field<'a> {
  Undefined,
  Value(&'a Value),
}

/// Reading a field of a body that does not exist (a request without a JSON
/// body). JavaScript threw a `TypeError` here, which became a 500.
#[derive(Debug)]
pub struct NoBody;

/// The parsed request body: `None` when the request had no JSON body.
#[derive(Clone, Debug, Default)]
pub struct Body(pub Option<Value>);

impl Body {
  pub fn field(&self, name: &str) -> Result<Field<'_>, NoBody> {
    match &self.0 {
      None => Err(NoBody),
      Some(value) => Ok(field_of(value, name)),
    }
  }

  /// Optional chaining (`body?.name`): a missing body reads as `undefined`.
  pub fn optional_field(&self, name: &str) -> Field<'_> {
    match &self.0 {
      None => Field::Undefined,
      Some(value) => field_of(value, name),
    }
  }
}

pub fn field_of<'a>(value: &'a Value, name: &str) -> Field<'a> {
  match value {
    Value::Object(map) => map.get(name).map_or(Field::Undefined, Field::Value),
    _ => Field::Undefined,
  }
}

impl<'a> Field<'a> {
  pub fn is_undefined(&self) -> bool {
    matches!(self, Field::Undefined)
  }

  /// `undefined` or `null`.
  pub fn is_nullish(&self) -> bool {
    matches!(self, Field::Undefined | Field::Value(Value::Null))
  }

  pub fn as_str(&self) -> Option<&'a str> {
    match self {
      Field::Value(Value::String(s)) => Some(s),
      _ => None,
    }
  }

  pub fn as_number(&self) -> Option<f64> {
    match self {
      Field::Value(Value::Number(n)) => n.as_f64(),
      _ => None,
    }
  }

  pub fn as_array(&self) -> Option<&'a Vec<Value>> {
    match self {
      Field::Value(Value::Array(items)) => Some(items),
      _ => None,
    }
  }

  pub fn as_object(&self) -> Option<&'a serde_json::Map<String, Value>> {
    match self {
      Field::Value(Value::Object(map)) => Some(map),
      _ => None,
    }
  }

  /// JavaScript truthiness.
  pub fn truthy(&self) -> bool {
    match self {
      Field::Undefined => false,
      Field::Value(value) => truthy(value),
    }
  }

  /// The text a template literal makes of the value.
  pub fn to_js_string(&self) -> String {
    match self {
      Field::Undefined => "undefined".to_string(),
      Field::Value(value) => to_js_string(value),
    }
  }

  /// The text an S3 request makes of a value used as a key: `None` where the
  /// AWS SDK refused to build the request (`undefined` or `null`).
  pub fn to_key(&self) -> Option<String> {
    if self.is_nullish() {
      None
    } else {
      Some(self.to_js_string())
    }
  }
}

pub fn truthy(value: &Value) -> bool {
  match value {
    Value::Null => false,
    Value::Bool(b) => *b,
    Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
    Value::String(s) => !s.is_empty(),
    Value::Array(_) | Value::Object(_) => true,
  }
}

pub fn to_js_string(value: &Value) -> String {
  match value {
    Value::Null => "null".to_string(),
    Value::Bool(b) => b.to_string(),
    Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_number),
    Value::String(s) => s.clone(),
    Value::Array(items) => items
      .iter()
      .map(|item| match item {
        Value::Null => String::new(),
        other => to_js_string(other),
      })
      .collect::<Vec<_>>()
      .join(","),
    Value::Object(_) => "[object Object]".to_string(),
  }
}

/// `String(n)` for a JSON number.
pub fn js_number(n: f64) -> String {
  if n.is_nan() {
    return "NaN".to_string();
  }
  if n.is_infinite() {
    return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
  }
  if n == 0.0 {
    return "0".to_string();
  }
  if n.fract() == 0.0 && n.abs() < 1e21 {
    return format!("{n:.0}");
  }
  let abs = n.abs();
  if !(1e-6..1e21).contains(&abs) {
    // JavaScript switches to exponent form outside this range.
    let formatted = format!("{n:e}");
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let sign = if exponent < 0 { "-" } else { "+" };
    return format!("{mantissa}e{sign}{}", exponent.abs());
  }
  format!("{n}")
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn template_strings_coerce_like_javascript() {
    assert_eq!(Field::Undefined.to_js_string(), "undefined");
    assert_eq!(to_js_string(&json!(null)), "null");
    assert_eq!(to_js_string(&json!(5)), "5");
    assert_eq!(to_js_string(&json!(1.5)), "1.5");
    assert_eq!(to_js_string(&json!(true)), "true");
    assert_eq!(to_js_string(&json!(["a", null, 1])), "a,,1");
    assert_eq!(to_js_string(&json!({"a": 1})), "[object Object]");
    assert_eq!(js_number(1e21), "1e+21");
    assert_eq!(js_number(1e-7), "1e-7");
    assert_eq!(js_number(-0.0), "0");
  }

  #[test]
  fn fields_of_a_missing_body_throw_and_others_read_undefined() {
    assert!(Body(None).field("key").is_err());
    assert!(Body(None).optional_field("key").is_undefined());
    let array = Body(Some(json!(["a"])));
    assert!(array.field("key").unwrap().is_undefined());
    let object = Body(Some(json!({"key": "k"})));
    assert_eq!(object.field("key").unwrap().as_str(), Some("k"));
  }

  #[test]
  fn truthiness() {
    for value in [json!(0), json!(""), json!(null), json!(false)] {
      assert!(!truthy(&value));
    }
    for value in [json!(1), json!("0"), json!([]), json!({})] {
      assert!(truthy(&value));
    }
  }
}
