//! Pure docking geometry. Positions and dimensions use physical pixels; DPI
//! enters only at explicit logical-size conversion and threshold boundaries.
use serde::{Deserialize, Serialize};

pub const PANEL_DEFAULT: (f64, f64) = (320., 420.);
pub const PANEL_MIN: (f64, f64) = (300., 360.);
pub const PANEL_MAX: (f64, f64) = (380., 520.);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Bounds {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
}
// Saved bounds use physical pixels; preserve mini sizes across DPI scaling.
pub(super) fn mini_bounds(mut bounds: Bounds, scale: f64) -> Bounds {
    if bounds.width as f64 > PANEL_MAX.0 * scale || bounds.height as f64 > PANEL_MAX.1 * scale {
        bounds.width = (PANEL_DEFAULT.0 * scale).round() as u32;
        bounds.height = (PANEL_DEFAULT.1 * scale).round() as u32;
    }
    bounds.width = bounds.width.max((PANEL_MIN.0 * scale).round() as u32);
    bounds.height = bounds.height.max((PANEL_MIN.1 * scale).round() as u32);
    bounds
}
pub(super) fn collapsed_bounds(
    panel: Bounds,
    area: Bounds,
    scale: f64,
    edge: Option<&str>,
) -> Bounds {
    let depth = ((56. * scale).round() as u32)
        .min(area.width)
        .min(area.height);
    let mut animal = Bounds {
        width: depth,
        height: depth,
        ..panel
    };
    match edge {
        Some("left") => {
            animal.x = area.x;
            animal.y = panel.y + (panel.height as i32 - depth as i32) / 2;
        }
        Some("right") => {
            animal.x = area.x + area.width as i32 - depth as i32;
            animal.y = panel.y + (panel.height as i32 - depth as i32) / 2;
        }
        Some("top") => {
            animal.y = area.y;
            animal.x = panel.x + (panel.width as i32 - depth as i32) / 2;
        }
        Some("bottom") => {
            animal.y = area.y + area.height as i32 - depth as i32;
            animal.x = panel.x + (panel.width as i32 - depth as i32) / 2;
        }
        _ => {}
    }
    animal.x = animal
        .x
        .clamp(area.x, area.x + area.width as i32 - depth as i32);
    animal.y = animal
        .y
        .clamp(area.y, area.y + area.height as i32 - depth as i32);
    animal
}
#[cfg(test)]
fn centered_bounds(
    source: Bounds,
    width: u32,
    height: u32,
    area: Bounds,
    edge: Option<&str>,
) -> Bounds {
    centered_from(
        (
            source.x as i64 * 2 + source.width as i64,
            source.y as i64 * 2 + source.height as i64,
        ),
        width,
        height,
        area,
        edge,
    )
}
// The center is stored at twice its physical coordinate to preserve half-pixel
// centers through repeated odd/even size changes, including negative coordinates.
pub(super) fn centered_from(
    center: (i64, i64),
    width: u32,
    height: u32,
    area: Bounds,
    edge: Option<&str>,
) -> Bounds {
    let width = width.min(area.width);
    let height = height.min(area.height);
    expanded_bounds(
        Bounds {
            x: (center.0 - width as i64).div_euclid(2) as i32,
            y: (center.1 - height as i64).div_euclid(2) as i32,
            width,
            height,
        },
        area,
        edge,
    )
}
pub(super) fn rescaled_bounds(mut bounds: Bounds, source_scale: f64, target_scale: f64) -> Bounds {
    let ratio = target_scale / source_scale;
    bounds.width = (bounds.width as f64 * ratio).round() as u32;
    bounds.height = (bounds.height as f64 * ratio).round() as u32;
    bounds
}
pub(super) fn expanded_bounds(mut bounds: Bounds, area: Bounds, edge: Option<&str>) -> Bounds {
    bounds.width = bounds.width.min(area.width);
    bounds.height = bounds.height.min(area.height);
    match edge {
        Some("left") => bounds.x = area.x,
        Some("right") => bounds.x = area.x + area.width as i32 - bounds.width as i32,
        Some("top") => bounds.y = area.y,
        Some("bottom") => bounds.y = area.y + area.height as i32 - bounds.height as i32,
        _ => {}
    }
    bounds.x = bounds
        .x
        .clamp(area.x, area.x + area.width as i32 - bounds.width as i32);
    bounds.y = bounds
        .y
        .clamp(area.y, area.y + area.height as i32 - bounds.height as i32);
    bounds
}
pub(super) fn detected_edge(bounds: Bounds, area: Bounds, scale: f64) -> Option<String> {
    let margin = (24. * scale).round() as i32;
    let candidates = [
        ("left", (bounds.x - area.x).max(0)),
        (
            "right",
            (area.x + area.width as i32 - bounds.x - bounds.width as i32).max(0),
        ),
        ("top", (bounds.y - area.y).max(0)),
        (
            "bottom",
            (area.y + area.height as i32 - bounds.y - bounds.height as i32).max(0),
        ),
    ];
    let (edge, distance) = candidates
        .into_iter()
        .min_by_key(|(_, distance)| *distance)?;
    (distance <= margin).then(|| edge.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animal_remains_on_screen_for_free_position_edges_and_display_scales() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -1920,
                y: 24,
                width: 1920,
                height: 1080,
            };
            let panel = Bounds {
                x: -700,
                y: 300,
                width: 640,
                height: 840,
            };
            let depth = (56. * scale).round() as u32;
            let free = collapsed_bounds(panel, area, scale, None);
            assert_eq!((free.x, free.y), (panel.x, panel.y));
            assert_eq!((free.width, free.height), (depth, depth));
            for edge in [
                None,
                Some("left"),
                Some("right"),
                Some("top"),
                Some("bottom"),
            ] {
                let outside = Bounds {
                    x: 100,
                    y: 1300,
                    ..panel
                };
                let animal = collapsed_bounds(outside, area, scale, edge);
                assert!(animal.x >= area.x && animal.y >= area.y);
                assert!(animal.x + animal.width as i32 <= area.x + area.width as i32);
                assert!(animal.y + animal.height as i32 <= area.y + area.height as i32);
            }
        }
    }

    #[test]
    fn saved_panels_migrate_to_mini_at_each_display_scale() {
        for scale in [1., 1.5, 2.] {
            let bounds = |width: f64, height: f64| Bounds {
                x: 80,
                y: 100,
                width: (width * scale).round() as u32,
                height: (height * scale).round() as u32,
            };
            assert_eq!(mini_bounds(bounds(440., 720.), scale), bounds(320., 420.));
            assert_eq!(mini_bounds(bounds(2940., 1674.), scale), bounds(320., 420.));
            assert_eq!(mini_bounds(bounds(350., 470.), scale), bounds(350., 470.));
            assert_eq!(mini_bounds(bounds(280., 300.), scale), bounds(300., 360.));
        }
    }

    #[test]
    fn panel_geometry_stays_on_its_own_edge_at_each_display_scale() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -2560,
                y: 48,
                width: 2560,
                height: 1600,
            };
            let panel = Bounds {
                x: -1900,
                y: 260,
                width: (320. * scale) as u32,
                height: (420. * scale) as u32,
            };
            for edge in [
                Some("left"),
                Some("right"),
                Some("top"),
                Some("bottom"),
                None,
            ] {
                let before = expanded_bounds(panel, area, edge);
                let resized = centered_bounds(
                    before,
                    (350. * scale) as u32,
                    (470. * scale) as u32,
                    area,
                    edge,
                );
                match edge {
                    Some("left") => {
                        assert_eq!(resized.x, area.x);
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("right") => {
                        assert_eq!(resized.x + resized.width as i32, area.x + area.width as i32);
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("top") => {
                        assert_eq!(resized.y, area.y);
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                    }
                    Some("bottom") => {
                        assert_eq!(
                            resized.y + resized.height as i32,
                            area.y + area.height as i32
                        );
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                    }
                    _ => {
                        assert!(
                            ((resized.x as i64 * 2 + resized.width as i64)
                                - (before.x as i64 * 2 + before.width as i64))
                                .abs()
                                <= 1
                        );
                        assert!(
                            ((resized.y as i64 * 2 + resized.height as i64)
                                - (before.y as i64 * 2 + before.height as i64))
                                .abs()
                                <= 1
                        );
                    }
                }
                // Restore uses panel geometry and never adds animal depth/gap.
                assert_eq!(expanded_bounds(before, area, edge), before);
                if edge.is_some() {
                    assert_eq!(detected_edge(before, area, scale).as_deref(), edge);
                }
            }
            assert_eq!(detected_edge(panel, area, scale), None);
            let near = Bounds {
                x: area.x + (23. * scale) as i32,
                ..panel
            };
            assert_eq!(detected_edge(near, area, scale).as_deref(), Some("left"));
            assert_eq!(
                detected_edge(
                    Bounds {
                        x: area.x + (26. * scale) as i32,
                        ..panel
                    },
                    area,
                    scale
                ),
                None
            );
        }
    }
    #[test]
    fn crossed_edges_are_recognized_and_restore_fits_overshoot_corners() {
        for scale in [1_f64, 1.5, 2.] {
            for area in [
                Bounds {
                    x: -1920,
                    y: -1080,
                    width: 1920,
                    height: 1080,
                },
                Bounds {
                    x: 1200,
                    y: 28,
                    width: 1600,
                    height: 1000,
                },
                Bounds {
                    x: 0,
                    y: 24,
                    width: 240,
                    height: 280,
                },
            ] {
                let panel = Bounds {
                    x: area.x + 100,
                    y: area.y + 100,
                    width: (320. * scale) as u32,
                    height: (420. * scale) as u32,
                };
                for (edge, b) in [
                    (
                        "left",
                        Bounds {
                            x: area.x - 120,
                            ..panel
                        },
                    ),
                    (
                        "right",
                        Bounds {
                            x: area.x + area.width as i32 - panel.width as i32 + 120,
                            ..panel
                        },
                    ),
                    (
                        "top",
                        Bounds {
                            y: area.y - 120,
                            ..panel
                        },
                    ),
                    (
                        "bottom",
                        Bounds {
                            y: area.y + area.height as i32 - panel.height as i32 + 120,
                            ..panel
                        },
                    ),
                ] {
                    // Old absolute-distance detection rejected overshoots >24px.
                    if panel.width <= area.width && panel.height <= area.height {
                        assert_eq!(detected_edge(b, area, scale).as_deref(), Some(edge));
                    }
                    let restored = expanded_bounds(b, area, Some(edge));
                    assert!(restored.x >= area.x && restored.y >= area.y);
                    assert!(restored.x + restored.width as i32 <= area.x + area.width as i32);
                    assert!(restored.y + restored.height as i32 <= area.y + area.height as i32);
                }
            }
        }
    }
    #[test]
    fn center_resize_repeated_dimensions_and_small_workareas_remain_fitted() {
        for scale in [1_f64, 1.5, 2.] {
            let area = Bounds {
                x: -3000,
                y: -1200,
                width: 6000,
                height: 3600,
            };
            let start = Bounds {
                x: -900,
                y: -600,
                width: (320. * scale) as u32,
                height: (420. * scale) as u32,
            };
            let mut panel = start;
            for _ in 0..8 {
                for (width, height) in [(380., 520.), (300., 360.), (350., 470.), (320., 420.)] {
                    panel = centered_from(
                        (
                            start.x as i64 * 2 + start.width as i64,
                            start.y as i64 * 2 + start.height as i64,
                        ),
                        (width * scale).round() as u32,
                        (height * scale).round() as u32,
                        area,
                        None,
                    );
                    assert!(
                        ((panel.x as i64 * 2 + panel.width as i64)
                            - (start.x as i64 * 2 + start.width as i64))
                            .abs()
                            <= 1
                    );
                    assert!(
                        ((panel.y as i64 * 2 + panel.height as i64)
                            - (start.y as i64 * 2 + start.height as i64))
                            .abs()
                            <= 1
                    );
                }
            }
            let tiny = Bounds {
                x: 100,
                y: -280,
                width: 240,
                height: 280,
            };
            assert_eq!(centered_bounds(panel, 760, 1040, tiny, None), tiny);
        }
    }
    #[test]
    fn monitor_changes_preserve_logical_dimensions() {
        let panel = Bounds {
            x: -900,
            y: 160,
            width: 350,
            height: 470,
        };
        let retina = rescaled_bounds(panel, 1., 2.);
        assert_eq!((retina.width, retina.height), (700, 940));
        assert_eq!((retina.x, retina.y), (panel.x, panel.y));
        assert_eq!(rescaled_bounds(retina, 2., 1.), panel);
        assert_eq!(mini_bounds(retina, 2.), retina);
    }

    #[test]
    fn edge_detection_includes_the_scaled_threshold_but_not_the_next_pixel() {
        let area = Bounds {
            x: -1920,
            y: -1080,
            width: 1920,
            height: 1080,
        };
        for scale in [1_f64, 1.5, 2.] {
            let threshold = (24. * scale).round() as i32;
            let panel = Bounds {
                x: area.x + threshold,
                y: area.y + 200,
                width: 320,
                height: 420,
            };
            assert_eq!(detected_edge(panel, area, scale).as_deref(), Some("left"));
            assert_eq!(
                detected_edge(
                    Bounds {
                        x: panel.x + 1,
                        ..panel
                    },
                    area,
                    scale
                ),
                None
            );
        }
    }

    #[test]
    fn persisted_bounds_preserve_physical_coordinates_and_field_names() {
        let value = serde_json::json!({"x":-1920,"y":24,"width":640,"height":840});
        let bounds: Bounds = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            bounds,
            Bounds {
                x: -1920,
                y: 24,
                width: 640,
                height: 840
            }
        );
        assert_eq!(serde_json::to_value(bounds).unwrap(), value);
    }
}
