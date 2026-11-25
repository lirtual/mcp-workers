//! Shared low-frequency cadence for the managed Linux and Windows Agent.
use std::time::{Duration, Instant};

pub struct AutomaticCheckSchedule {
    next_check: Instant,
}

impl AutomaticCheckSchedule {
    pub fn new(now: Instant, jitter_seconds: u64) -> Self {
        Self {
            next_check: now + Duration::from_secs(60 + jitter_seconds.min(240)),
        }
    }

    pub fn is_due(&self, now: Instant) -> bool {
        now >= self.next_check
    }

    pub fn take_due(&mut self, now: Instant, jitter_seconds: u64) -> bool {
        if now < self.next_check {
            return false;
        }
        self.next_check = now + Duration::from_secs(6 * 3600 - 900 + jitter_seconds.min(1800));
        true
    }
}

pub fn automatic_jitter(max: u64) -> u64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0;
    }
    u64::from_le_bytes(bytes) % (max + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_check_has_bounded_startup_and_low_frequency_cadence() {
        let start = std::time::Instant::now();
        let mut schedule = AutomaticCheckSchedule::new(start, 120);
        assert!(!schedule.take_due(start + Duration::from_secs(179), 0));
        assert!(schedule.take_due(start + Duration::from_secs(180), 900));
        assert!(!schedule.take_due(start + Duration::from_secs(181), 0));
        assert!(!schedule.take_due(start + Duration::from_secs(180 + 6 * 3600 - 1), 0));
        assert!(schedule.take_due(start + Duration::from_secs(180 + 6 * 3600), 1800));
        assert!(!schedule.take_due(start + Duration::from_secs(180 + 12 * 3600), 0));
        assert!(schedule.take_due(start + Duration::from_secs(180 + 12 * 3600 + 900), 0));
    }
}
