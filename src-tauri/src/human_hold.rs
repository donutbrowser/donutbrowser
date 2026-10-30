//! How a hand keeps a button down: how long it really holds, and the small
//! movements the pointer makes meanwhile.
//!
//! A hand on a mouse is never perfectly still. While it keeps a button down,
//! the pointer makes a few sub-pixel to one-pixel movements at irregular
//! times, the first one soon after the press, and it stays near where it
//! pressed. The hand lets go a little after the time it aimed for, never
//! before. Press-and-hold checks read a pointer that does not move at all, a
//! hold of an exact length or evenly spaced events as a script.

use rand::RngExt;

/// Shortest, longest and default hold, in milliseconds.
pub const MIN_HOLD_MS: u64 = 100;
pub const MAX_HOLD_MS: u64 = 30_000;
pub const DEFAULT_HOLD_MS: u64 = 3_000;
/// Most a held pointer wanders from where it pressed, in CSS pixels.
pub const TREMOR_RADIUS_PX: f64 = 1.4;
/// A held movement is never shorter than this, in CSS pixels.
const MIN_TREMOR_STEP_PX: f64 = 0.3;
/// Time kept free before the release for the last movement to finish: a
/// humanized move takes at least 180 ms to dispatch.
const MOVE_RESERVE_MS: u64 = 260;

/// One movement of the held pointer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TremorMove {
  /// When, in milliseconds after the press.
  pub at_ms: u64,
  /// Where to, as an offset from the press point in CSS pixels.
  pub dx: f64,
  pub dy: f64,
}

/// One hold, planned before the press.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldPlan {
  /// The pause between the pointer's arrival and the press.
  pub settle_ms: u64,
  /// How long the button stays down, from the press.
  pub hold_ms: u64,
  /// The movements while the button is down, in time order.
  pub moves: Vec<TremorMove>,
}

/// Two decimals: finer than any pixel grid a page sees.
fn hundredths(value: f64) -> f64 {
  (value * 100.0).round() / 100.0
}

/// A normal draw from two uniform ones (Box-Muller).
fn normal(uniform: &mut impl FnMut() -> f64) -> f64 {
  let u1 = uniform().max(1e-9);
  let u2 = uniform();
  (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

/// Plan a hold of `requested_ms`. `uniform` draws from `[0, 1)`.
pub fn plan_hold(requested_ms: u64, uniform: &mut impl FnMut() -> f64) -> HoldPlan {
  let settle_ms = 90 + (uniform() * 170.0) as u64;
  // Two to nine percent over the aim, plus up to 45 ms: never under it.
  let hold_ms = (requested_ms as f64 * (1.02 + 0.07 * uniform()) + 45.0 * uniform()).round() as u64;

  let mut moves = Vec::new();
  let (mut x, mut y) = (0.0_f64, 0.0_f64);
  // The first movement is the press itself jolting the hand.
  let mut at = 70.0 + uniform() * 190.0;
  while at as u64 + MOVE_RESERVE_MS <= hold_ms {
    let heading = std::f64::consts::TAU * uniform();
    let size = 0.35 + 0.75 * uniform();
    // Pulled back towards the press point, so the pointer drifts around it
    // instead of walking away.
    let (mut nx, mut ny) = (
      x * 0.55 + heading.cos() * size,
      y * 0.55 + heading.sin() * size,
    );
    let reach = nx.hypot(ny);
    if reach > TREMOR_RADIUS_PX {
      let scale = TREMOR_RADIUS_PX * (0.85 + 0.15 * uniform()) / reach;
      nx *= scale;
      ny *= scale;
    }
    if (nx - x).hypot(ny - y) < MIN_TREMOR_STEP_PX {
      // Too small to be a movement: step along the drawn heading instead, or
      // back towards the press point at the edge.
      let (ux, uy) = (heading.cos() * 0.45, heading.sin() * 0.45);
      (nx, ny) = if (x + ux).hypot(y + uy) <= TREMOR_RADIUS_PX {
        (x + ux, y + uy)
      } else if (x - ux).hypot(y - uy) <= TREMOR_RADIUS_PX {
        (x - ux, y - uy)
      } else {
        let reach = x.hypot(y);
        (x * (1.0 - 0.45 / reach), y * (1.0 - 0.45 / reach))
      };
    }
    x = hundredths(nx);
    y = hundredths(ny);
    moves.push(TremorMove {
      at_ms: at as u64,
      dx: x,
      dy: y,
    });
    // A short floor plus a log-normal gap around half a second: mostly short,
    // now and then a long still spell, never a repeated bound.
    let gap = 130.0 + (430.0_f64.ln() + 0.6 * normal(uniform)).exp();
    at += if gap > 2400.0 {
      2000.0 + 400.0 * uniform()
    } else {
      gap
    };
  }
  HoldPlan {
    settle_ms,
    hold_ms,
    moves,
  }
}

/// A plan drawn from the thread's generator.
pub fn random_plan(requested_ms: u64) -> HoldPlan {
  let mut rng = rand::rng();
  plan_hold(requested_ms, &mut || rng.random::<f64>())
}

/// The CDP `buttons` mask of a held button.
pub fn buttons_mask(button: &str) -> u8 {
  match button {
    "right" => 2,
    "middle" => 4,
    _ => 1,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A fixed sequence, so a plan is the same on every run.
  fn seeded(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    move || {
      state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
      (state >> 11) as f64 / (1u64 << 53) as f64
    }
  }

  #[test]
  fn holds_a_little_past_the_aim_and_never_less() {
    for seed in 0..200 {
      for requested in [MIN_HOLD_MS, DEFAULT_HOLD_MS, MAX_HOLD_MS] {
        let plan = plan_hold(requested, &mut seeded(seed));
        assert!(plan.hold_ms >= requested + requested / 50, "{plan:?}");
        assert!(
          plan.hold_ms <= requested + requested * 9 / 100 + 46,
          "{plan:?}"
        );
        assert!((90..=260).contains(&plan.settle_ms));
      }
    }
    let lengths: std::collections::HashSet<u64> = (0..50)
      .map(|seed| plan_hold(5_000, &mut seeded(seed)).hold_ms)
      .collect();
    assert!(lengths.len() > 40);
  }

  #[test]
  fn moves_the_held_pointer_a_little_at_irregular_times_near_the_press_point() {
    let mut all_gaps = Vec::new();
    for seed in 0..200 {
      let plan = plan_hold(6_000, &mut seeded(seed));
      assert!(plan.moves.len() >= 3, "{plan:?}");
      assert!((70..=260).contains(&plan.moves[0].at_ms));
      let mut previous = (0.0, 0.0);
      for (i, m) in plan.moves.iter().enumerate() {
        assert!(m.dx.hypot(m.dy) <= TREMOR_RADIUS_PX + 0.01, "{m:?}");
        let step = (m.dx - previous.0).hypot(m.dy - previous.1);
        assert!(step >= MIN_TREMOR_STEP_PX - 0.01, "{m:?}");
        assert!(m.at_ms + MOVE_RESERVE_MS <= plan.hold_ms);
        if i > 0 {
          let gap = m.at_ms - plan.moves[i - 1].at_ms;
          assert!((130..=2400).contains(&gap), "{gap}");
          all_gaps.push(gap);
        }
        previous = (m.dx, m.dy);
      }
    }
    // Irregular: no interval recurs the way a timer's or a bound's does.
    let mut counts = std::collections::HashMap::new();
    for gap in &all_gaps {
      *counts.entry(*gap).or_insert(0usize) += 1;
    }
    let most = counts.values().max().copied().unwrap_or(0);
    assert!(most * 100 <= all_gaps.len(), "{most} of {}", all_gaps.len());
  }

  #[test]
  fn a_hold_too_short_for_a_move_only_presses_and_lets_go() {
    assert!(plan_hold(MIN_HOLD_MS, &mut seeded(3)).moves.is_empty());
    assert_eq!(buttons_mask("left"), 1);
    assert_eq!(buttons_mask("right"), 2);
    assert_eq!(buttons_mask("middle"), 4);
    assert!(random_plan(2_000).hold_ms >= 2_040);
  }
}
