//! Plain log lines: `LOG` to stdout, `WARN` and `ERROR` to stderr.

use crate::time;

fn line(level: &str, context: &str, message: &str) -> String {
  format!(
    "{} {level} [{context}] {message}",
    time::iso_from_ms(time::now_ms())
  )
}

pub fn log(context: &str, message: &str) {
  println!("{}", line("LOG", context, message));
}

pub fn warn(context: &str, message: &str) {
  eprintln!("{}", line("WARN", context, message));
}

pub fn error(context: &str, message: &str) {
  eprintln!("{}", line("ERROR", context, message));
}
