use super::*;
use crate::store::collect;

const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const K2: &str = "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

fn keyring(value: &str) -> Arc<Keyring> {
  Arc::new(Keyring::parse(value).unwrap())
}

fn sample(len: usize) -> Vec<u8> {
  (0..len).map(|i| (i * 31 + 7) as u8).collect()
}

const SIZES: [usize; 9] = [
  0,
  1,
  FRAME - 1,
  FRAME,
  FRAME + 1,
  2 * FRAME - 1,
  2 * FRAME,
  2 * FRAME + 1,
  3 * FRAME + 1234,
];

fn header_bytes(id: &str) -> usize {
  header_len(id) as usize
}

#[test]
fn every_boundary_size_round_trips_with_the_size_math() {
  let keys = keyring(K1);
  for size in SIZES {
    let plain = sample(size);
    let sealed = seal(&keys, &plain);
    assert_eq!(
      sealed.len() as u64,
      sealed_len("k1", size as u64),
      "size {size}"
    );
    assert_eq!(
      plain_len("k1", sealed.len() as u64),
      Some(size as u64),
      "size {size}"
    );
    assert_eq!(open(keys.clone(), &sealed).unwrap(), plain, "size {size}");
  }
}

#[test]
fn an_empty_object_is_one_empty_final_frame() {
  let keys = keyring(K1);
  let sealed = seal(&keys, b"");
  assert_eq!(sealed.len(), header_bytes("k1") + TAG);
  assert_eq!(open(keys, &sealed).unwrap(), b"");
}

#[test]
fn sizes_no_sealed_object_has_are_refused() {
  let header = header_len("k1");
  assert_eq!(plain_len("k1", 0), None);
  assert_eq!(plain_len("k1", header), None);
  assert_eq!(plain_len("k1", header + TAG as u64 - 1), None);
  assert_eq!(plain_len("k1", header + (FRAME + TAG) as u64 + 3), None);
  assert_eq!(plain_len("k1", header + TAG as u64), Some(0));
}

#[test]
fn any_flipped_byte_is_refused() {
  let keys = keyring(K1);
  let sealed = seal(&keys, &sample(FRAME + 100));
  let header = header_bytes("k1");
  // Magic, version, key id, salt, first frame, first tag, last frame, last tag.
  for at in [
    0,
    4,
    6,
    header - 1,
    header,
    header + FRAME + TAG - 1,
    header + FRAME + TAG,
    sealed.len() - 1,
  ] {
    let mut forged = sealed.clone();
    forged[at] ^= 1;
    assert!(
      matches!(open(keys.clone(), &forged), Err(StoreError::Corrupt(_))),
      "byte {at}"
    );
  }
}

#[test]
fn truncation_anywhere_is_refused() {
  let keys = keyring(K1);
  let sealed = seal(&keys, &sample(2 * FRAME + 10));
  let header = header_bytes("k1");
  let frame = FRAME + TAG;
  for cut in [
    0,
    3,
    header - 1,
    header,
    header + 5,
    header + frame,
    header + 2 * frame,
    sealed.len() - 1,
  ] {
    assert!(
      matches!(
        open(keys.clone(), &sealed[..cut]),
        Err(StoreError::Corrupt(_))
      ),
      "cut at {cut}"
    );
  }
  // Exactly at a frame boundary of an object whose last frame is full.
  let full = seal(&keys, &sample(2 * FRAME));
  assert!(open(keys.clone(), &full[..header + frame]).is_err());
}

#[test]
fn reordered_dropped_or_appended_frames_are_refused() {
  let keys = keyring(K1);
  let sealed = seal(&keys, &sample(3 * FRAME));
  let header = header_bytes("k1");
  let frame = FRAME + TAG;
  let part = |i: usize| &sealed[header + i * frame..header + (i + 1) * frame];
  let swapped = [&sealed[..header], part(1), part(0), part(2)].concat();
  assert!(open(keys.clone(), &swapped).is_err());
  let dropped = [&sealed[..header], part(0), part(2)].concat();
  assert!(open(keys.clone(), &dropped).is_err());
  let appended = [&sealed[..], &[0u8; TAG]].concat();
  assert!(open(keys.clone(), &appended).is_err());
}

#[test]
fn a_frame_from_another_object_is_refused() {
  let keys = keyring(K1);
  let a = seal(&keys, &sample(10));
  let b = seal(&keys, &sample(10));
  let header = header_bytes("k1");
  let spliced = [&a[..header], &b[header..]].concat();
  assert!(open(keys, &spliced).is_err());
}

#[test]
fn the_wrong_key_or_an_unknown_key_id_is_refused() {
  let sealed = seal(&keyring(K1), b"secret");
  let impostor = keyring("k1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=");
  assert!(matches!(
    open(impostor, &sealed),
    Err(StoreError::Corrupt(_))
  ));
  let other = keyring(K2);
  match open(other, &sealed) {
    Err(StoreError::Corrupt(message)) => assert!(message.contains("'k1'")),
    other => panic!("{other:?}"),
  }
}

#[test]
fn an_old_key_still_reads_after_rotation_and_new_writes_use_the_first() {
  let old = seal(&keyring(K1), b"before");
  let rotated = keyring(&format!("{K2},{K1}"));
  assert_eq!(open(rotated.clone(), &old).unwrap(), b"before");
  let new = seal(&rotated, b"after");
  assert_eq!(&new[6..8], b"k2");
  assert_eq!(rotated.marker(), "1:k2");
  assert!(open(keyring(K1), &new).is_err());
}

#[test]
fn the_same_plaintext_seals_differently_each_time() {
  let keys = keyring(K1);
  assert_ne!(seal(&keys, b"same"), seal(&keys, b"same"));
}

fn chunked(data: Vec<u8>, sizes: &[usize]) -> crate::store::ByteStream {
  let mut chunks = Vec::new();
  let mut at = 0;
  let mut i = 0;
  while at < data.len() {
    let n = sizes[i % sizes.len()].min(data.len() - at);
    chunks.push(Ok(Bytes::copy_from_slice(&data[at..at + n])));
    at += n;
    i += 1;
  }
  Box::pin(futures_util::stream::iter(chunks))
}

#[tokio::test]
async fn streams_match_the_whole_buffer_functions_for_any_chunking() {
  let keys = keyring(K1);
  for size in SIZES {
    let plain = sample(size);
    for sizes in [
      &[1usize][..],
      &[7, 4093, 65_537],
      &[FRAME],
      &[3 * FRAME + 9999],
    ] {
      if size > 3 * FRAME && sizes == [1] {
        continue;
      }
      let sealed = collect(seal_stream(&keys, chunked(plain.clone(), sizes)))
        .await
        .unwrap();
      assert_eq!(sealed.len() as u64, sealed_len("k1", size as u64));
      assert_eq!(open(keys.clone(), &sealed).unwrap(), plain);
      let opened = collect(open_stream(keys.clone(), chunked(sealed, sizes)))
        .await
        .unwrap();
      assert_eq!(opened, plain, "size {size} chunks {sizes:?}");
    }
  }
}

#[tokio::test]
async fn a_cut_stream_ends_in_an_error_not_a_short_body() {
  let keys = keyring(K1);
  let sealed = seal(&keys, &sample(2 * FRAME + 5));
  let cut = sealed[..sealed.len() - 3].to_vec();
  let result = collect(open_stream(keys, chunked(cut, &[1000]))).await;
  assert!(matches!(result, Err(StoreError::Corrupt(_))));
}

#[test]
fn keyrings_parse_strictly() {
  assert_eq!(keyring(&format!(" {K2} , {K1} ")).current().id(), "k2");
  let url_safe = keyring("a.b_c-1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
  assert_eq!(url_safe.key_count(), 1);
  for bad in [
    "",
    ",",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "k1:AAAA",
    "k1:not base64!",
    "k 1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ":AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    &format!("{K1},{K1}"),
    &format!(
      "{}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "k".repeat(33)
    ),
  ] {
    assert!(Keyring::parse(bad).is_err(), "{bad}");
  }
}

#[test]
fn markers_name_their_key() {
  assert_eq!(marker_key_id("1:k1"), Some("k1"));
  assert_eq!(marker_key_id("2:k1"), None);
  assert_eq!(marker_key_id("1:"), None);
}

mod sealed_store {
  use super::*;
  use crate::memory_store::MemoryStore;
  use crate::sealed_store::SealedStore;
  use crate::store::{Store, Upload, once};

  fn stores() -> (Arc<MemoryStore>, SealedStore) {
    let raw = Arc::new(MemoryStore::default());
    let sealed = SealedStore::new(raw.clone(), keyring(K1));
    (raw, sealed)
  }

  #[tokio::test]
  async fn writes_are_sealed_and_read_back_as_written() {
    let (raw, store) = stores();
    let metadata = vec![("updated-at".to_string(), "42".to_string())];
    let plain = sample(FRAME + 3);
    store
      .put_object_stream(
        "a",
        once(plain.clone()),
        Upload {
          length: plain.len() as u64,
          content_type: Some("application/octet-stream"),
          metadata: &metadata,
          if_match: None,
        },
      )
      .await
      .unwrap();
    let stored = raw.raw("a").unwrap();
    assert_ne!(stored.body, plain);
    assert_eq!(&stored.body[..4], b"DSAR");
    assert!(
      stored
        .metadata
        .contains(&(MARKER.to_string(), "1:k1".to_string()))
    );

    let head = store.head_object("a").await.unwrap();
    assert_eq!(head.content_length, Some(plain.len() as u64));
    assert_eq!(head.metadata, metadata);
    let download = store.get_object("a").await.unwrap();
    assert_eq!(
      download.head.content_type.as_deref(),
      Some("application/octet-stream")
    );
    assert_eq!(collect(download.body).await.unwrap(), plain);

    store
      .put_object("t", b"{\"x\":1}".to_vec(), "application/json", &[])
      .await
      .unwrap();
    assert_ne!(raw.get("t").unwrap(), "{\"x\":1}");
    assert_eq!(store.get_object_text("t").await.unwrap(), "{\"x\":1}");
  }

  #[tokio::test]
  async fn plaintext_objects_from_before_read_unchanged() {
    let (raw, store) = stores();
    raw.insert(
      "old",
      b"DSAR looks sealed but has no marker".to_vec(),
      vec![("updated-at".to_string(), "7".to_string())],
      None,
    );
    let head = store.head_object("old").await.unwrap();
    assert_eq!(head.content_length, Some(35));
    assert_eq!(
      head.metadata,
      vec![("updated-at".to_string(), "7".to_string())]
    );
    assert_eq!(
      store.get_object_text("old").await.unwrap(),
      "DSAR looks sealed but has no marker"
    );
  }

  #[tokio::test]
  async fn reads_report_the_time_before_the_migration_and_copies_their_own() {
    let (raw, store) = stores();
    let sealed = seal(&keyring(K1), b"x");
    raw.insert(
      "a",
      sealed,
      vec![
        (MARKER.to_string(), "1:k1".to_string()),
        ("donut-orig-mtime".to_string(), "1234".to_string()),
        ("updated-at".to_string(), "5".to_string()),
      ],
      Some("text/plain".to_string()),
    );
    let head = store.head_object("a").await.unwrap();
    assert_eq!(head.last_modified_ms, Some(1234));
    assert_eq!(
      head.metadata,
      vec![("updated-at".to_string(), "5".to_string())]
    );
    let download = store.get_object("a").await.unwrap();
    assert_eq!(download.head.last_modified_ms, Some(1234));

    store.copy_object("a", "b").await.unwrap();
    let copy = raw.raw("b").unwrap();
    assert!(
      copy
        .metadata
        .contains(&("donut-orig-mtime".to_string(), "-".to_string()))
    );
    assert_eq!(copy.content_type.as_deref(), Some("text/plain"));
    let head = store.head_object("b").await.unwrap();
    assert_eq!(head.last_modified_ms, Some(copy.modified_ms));
    assert_eq!(
      head.metadata,
      vec![("updated-at".to_string(), "5".to_string())]
    );
    assert_eq!(store.get_object_text("b").await.unwrap(), "x");
  }

  #[tokio::test]
  async fn copies_stay_readable() {
    let (_, store) = stores();
    store
      .put_object("a", b"x".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    store.copy_object("a", "b").await.unwrap();
    assert_eq!(store.get_object_text("b").await.unwrap(), "x");
  }
}

#[tokio::test]
async fn an_object_sealed_in_parts_reads_like_one_sealed_whole() {
  let keys = keyring(K1);
  let part = 2 * FRAME;
  for size in [
    0,
    1,
    part - 1,
    part,
    part + 1,
    2 * part,
    3 * part + FRAME + 5,
  ] {
    let plain = sample(size);
    let salt = new_salt();
    let parts = size.div_ceil(part).max(1);
    let mut sealed = Vec::new();
    for i in 0..parts {
      let start = i * part;
      let chunk = plain[start..(start + part).min(size)].to_vec();
      let last = i + 1 == parts;
      let sealer = Sealer::for_part(&keys, "k1", &salt, (start / FRAME) as u64).unwrap();
      let len = chunk.len() as u64;
      let out = collect(seal_part_stream(sealer, last, chunked(chunk, &[777])))
        .await
        .unwrap();
      assert_eq!(
        out.len() as u64,
        sealed_part_len("k1", len, i == 0, last),
        "size {size} part {i}"
      );
      sealed.extend(out);
    }
    assert_eq!(
      sealed.len() as u64,
      sealed_len("k1", size as u64),
      "size {size}"
    );
    assert_eq!(open(keys.clone(), &sealed).unwrap(), plain, "size {size}");
  }
  assert!(Sealer::for_part(&keys, "k9", &new_salt(), 0).is_none());
}

#[tokio::test]
async fn parts_out_of_place_do_not_open() {
  let keys = keyring(K1);
  let salt = new_salt();
  let part = |first: u64, last: bool, data: Vec<u8>| {
    let sealer = Sealer::for_part(&keys, "k1", &salt, first).unwrap();
    collect(seal_part_stream(sealer, last, chunked(data, &[FRAME])))
  };
  let one = part(0, false, sample(FRAME)).await.unwrap();
  let two = part(1, true, sample(10)).await.unwrap();
  assert!(open(keys.clone(), &[one.clone(), two.clone()].concat()).is_ok());
  // A part numbered as if it came later, or a non-final part last.
  let skipped = part(2, true, sample(10)).await.unwrap();
  assert!(open(keys.clone(), &[one.clone(), skipped].concat()).is_err());
  let unfinished = part(1, false, sample(FRAME)).await.unwrap();
  assert!(open(keys.clone(), &[one, unfinished].concat()).is_err());
}
