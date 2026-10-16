//! Bounded terminal drawing and UTF-8 editor; no core calls or filesystem actions.
use crate::app::App;
use crate::workspace::{Focus, Workspace, MENUS};
use anyhow::Result;
use crossterm::{
    cursor::{Hide, MoveTo, Show},
    queue,
    style::{
        Attribute, Color, Print, ResetColor, SetAttribute, SetBackgroundColor, SetForegroundColor,
    },
    terminal::{self, Clear, ClearType},
};
use pickdrop_core::protocol::s;
use std::io::{stdout, Write};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
#[derive(Default)]
pub(crate) struct Editor {
    pub text: String,
    pub cursor: usize,
}
impl Editor {
    pub fn insert(&mut self, value: &str) -> Result<()> {
        let clean: String = value
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        anyhow::ensure!(
            self.text.len() + clean.len() <= 16 * 1024,
            "输入超过 16 KiB，原内容已保留"
        );
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
        Ok(())
    }
    pub fn left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0);
    }
    pub fn right(&mut self) {
        self.cursor += self.text[self.cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(0);
    }
    pub fn backspace(&mut self) {
        let end = self.cursor;
        self.left();
        self.text.replace_range(self.cursor..end, "");
    }
    pub fn delete(&mut self) {
        let start = self.cursor;
        self.right();
        let end = self.cursor;
        self.cursor = start;
        self.text.replace_range(start..end, "");
    }
}
pub fn safe_text(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}
fn clip(text: &str, width: usize) -> String {
    let mut columns = 0;
    safe_text(text)
        .chars()
        .take_while(|c| {
            columns += c.width().unwrap_or(0);
            columns <= width
        })
        .collect()
}
fn wrapped(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![];
    }
    let mut lines = vec![];
    let mut line = String::new();
    let mut columns = 0;
    for c in safe_text(text).chars() {
        let size = c.width().unwrap_or(0);
        if columns + size > width {
            lines.push(std::mem::take(&mut line));
            columns = 0;
        }
        if size <= width {
            line.push(c);
            columns += size;
        }
    }
    lines.push(line);
    lines
}
#[derive(Debug)]
struct Layout {
    width: usize,
    height: usize,
    sidebar: usize,
    content: usize,
    rows: usize,
}
impl Layout {
    fn new(width: usize, height: usize) -> Option<Self> {
        if width < 36 || height < 12 {
            return None;
        }
        let sidebar = if width >= 72 {
            if width >= 100 {
                24
            } else {
                20
            }
        } else {
            0
        };
        Some(Self {
            width: width - 1,
            height,
            sidebar,
            content: width - 1 - sidebar,
            rows: height - 9,
        })
    }
}
fn paint(
    output: &mut impl Write,
    x: usize,
    y: usize,
    text: &str,
    width: usize,
    selected: bool,
) -> Result<()> {
    let text = clip(text, width);
    queue!(output, MoveTo(x as u16, y as u16))?;
    let color = std::env::var_os("NO_COLOR").is_none();
    if selected && color {
        queue!(
            output,
            SetBackgroundColor(Color::DarkBlue),
            SetForegroundColor(Color::White),
            SetAttribute(Attribute::Bold)
        )?;
    }
    queue!(
        output,
        Print(&text),
        Print(" ".repeat(width.saturating_sub(UnicodeWidthStr::width(text.as_str()))))
    )?;
    if color {
        queue!(output, ResetColor, SetAttribute(Attribute::Reset))?;
    }
    Ok(())
}
pub(crate) fn render(app: &App, editor: &Editor, ui: &Workspace, busy: bool) -> Result<()> {
    let (width, height) = terminal::size()?;
    let mut output = stdout();
    queue!(output, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    let Some(layout) = Layout::new(width as usize, height as usize) else {
        if width > 0 && height > 0 {
            queue!(
                output,
                Print(clip(
                    "终端至少需要 36 列 × 12 行；Ctrl+C 退出",
                    width.saturating_sub(1) as usize
                ))
            )?;
        }
        output.flush()?;
        return Ok(());
    };
    let w = layout.width;
    let h = layout.height;
    let name = app
        .groups()
        .iter()
        .find(|g| g["id"] == app.boot["activeGroupId"])
        .map(|g| s(g, "name"))
        .unwrap_or("尚未加入群组");
    let online = app.state["devices"]
        .as_array()
        .map(|d| d.iter().filter(|d| d["online"] == true).count())
        .unwrap_or(0);
    paint(
        &mut output,
        0,
        0,
        &format!(
            "拾传 {} | {} | {} 在线{}",
            env!("CARGO_PKG_VERSION"),
            name,
            online,
            if busy { " | 处理中" } else { "" }
        ),
        w,
        false,
    )?;
    let narrow = layout.sidebar == 0;
    paint(
        &mut output,
        0,
        1,
        &format!(
            "{} · {} · {}{}",
            if narrow { "单栏" } else { "双栏" },
            match ui.focus {
                Focus::Menu => "焦点：菜单",
                Focus::Content => "焦点：内容",
                Focus::Input => "焦点：输入",
            },
            MENUS[ui.menu],
            if s(&app.boot["endpoint"], "baseUrl").starts_with("http://127.") {
                " · 仅本机监听，其他设备无法直连下载"
            } else {
                ""
            }
        ),
        w,
        false,
    )?;
    let show_menu = !narrow || ui.focus == Focus::Menu;
    if show_menu {
        let side = if narrow { w } else { layout.sidebar - 1 };
        let start = ui.menu.saturating_sub(layout.rows.saturating_sub(1));
        for (row, index) in (start..MENUS.len()).take(layout.rows).enumerate() {
            paint(
                &mut output,
                0,
                row + 3,
                &format!(
                    "{} {}",
                    if index == ui.menu { "▶" } else { " " },
                    MENUS[index]
                ),
                side,
                index == ui.menu && ui.focus == Focus::Menu,
            )?;
        }
    }
    if !narrow || !show_menu {
        let x = layout.sidebar;
        let cw = layout.content;
        paint(
            &mut output,
            x,
            2,
            MENUS[ui.menu],
            cw,
            ui.focus == Focus::Content,
        )?;
        let mut lines: Vec<(String, bool)> = vec![];
        let mut selected_start = 0;
        if let Some((title, _)) = &ui.confirmation {
            lines.extend(
                wrapped(title, cw)
                    .into_iter()
                    .take(layout.rows.saturating_sub(2))
                    .map(|s| (s, false)),
            );
            lines.push((
                format!(
                    "{} 取消     {} 确认",
                    if !ui.confirm_yes { "[✓]" } else { "[ ]" },
                    if ui.confirm_yes { "[✓]" } else { "[ ]" }
                ),
                true,
            ));
            lines.push(("←→ / ↑↓ 选择 · Enter 执行 · Esc 取消".into(), false));
        } else if let Some((title, _)) = &ui.form {
            lines.extend(wrapped(title, cw).into_iter().map(|s| (s, false)));
            lines.push((
                "底部输入；Enter 提交 · Esc 取消 · Ctrl+U 清空".into(),
                false,
            ));
        } else if let Some(detail) = &app.detail {
            for line in detail {
                lines.extend(wrapped(line, cw).into_iter().map(|s| (s, false)));
            }
        } else {
            for line in ui.context(app).into_iter().take(2) {
                lines.push((clip(&line, cw), false));
            }
            let rows = ui.rows(app);
            let index = ui.index(&rows);
            for (i, row) in rows.iter().enumerate() {
                if i == index {
                    selected_start = lines.len();
                }
                let prefix = if i == index && ui.focus == Focus::Content {
                    "▶ "
                } else {
                    "  "
                };
                let parts = wrapped(&row.label, cw.saturating_sub(2));
                // Cap each list entry so a very long message cannot conceal navigation.
                for (j, part) in parts.iter().take(3).enumerate() {
                    lines.push((
                        format!("{}{}", if j == 0 { prefix } else { "  " }, part),
                        i == index && ui.focus == Focus::Content,
                    ));
                }
            }
            if rows.is_empty() {
                lines.push(("暂无内容；← 返回菜单选择其他功能".into(), false));
            }
        }
        let start = if app.detail.is_some() {
            app.scroll.min(lines.len().saturating_sub(layout.rows))
        } else {
            selected_start.saturating_sub(layout.rows.saturating_sub(3))
        };
        for (row, (line, selected)) in lines.iter().skip(start).take(layout.rows).enumerate() {
            paint(&mut output, x, 3 + row, line, cw, *selected)?;
        }
    }
    let draft = app
        .current_draft()
        .ok()
        .map(|d| {
            format!(
                "待发送：{}（未发送）",
                d.path
                    .file_name()
                    .unwrap_or(d.path.as_os_str())
                    .to_string_lossy()
            )
        })
        .unwrap_or_else(|| {
            if s(&app.boot["endpoint"], "baseUrl").starts_with("http://127.") {
                "仅本机监听 127.0.0.1；其他设备无法直连下载".into()
            } else {
                "文件先暂存，再确认发送；切群不改变附件目标".into()
            }
        });
    paint(&mut output, 0, h - 5, &draft, w, false)?;
    paint(&mut output, 0, h - 4, &app.notice, w, false)?;
    paint(
        &mut output,
        0,
        h - 3,
        "↑↓ 选择 · ←→ / Tab 切栏 · Enter 确认 · Esc 返回",
        w,
        false,
    )?;
    paint(
        &mut output,
        0,
        h - 2,
        "i 写消息 · / 命令 · PgUp/PgDn 翻页 · Ctrl+C 退出",
        w,
        false,
    )?;
    if ui.focus == Focus::Input {
        let mut offset = 0;
        while UnicodeWidthStr::width(&editor.text[offset..editor.cursor]) > w - 3 {
            offset += editor.text[offset..].chars().next().unwrap().len_utf8();
        }
        let column = 2 + UnicodeWidthStr::width(&editor.text[offset..editor.cursor]);
        paint(
            &mut output,
            0,
            h - 1,
            &format!("> {}", clip(&editor.text[offset..], w - 2)),
            w,
            false,
        )?;
        queue!(
            output,
            MoveTo(column.min(w - 1) as u16, (h - 1) as u16),
            Show
        )?;
    } else {
        paint(
            &mut output,
            0,
            h - 1,
            "选择菜单 → 进入内容 → Enter 操作",
            w,
            false,
        )?;
    }
    output.flush()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_names_cannot_write_terminal_escape_sequences() {
        let text = "file\x1b[2J\n\u{009b}31m";
        assert!(!safe_text(text).chars().any(char::is_control));
        assert_eq!(clip("中文abc", 5), "中文a");
        assert_eq!(wrapped("中文abc", 4), vec!["中文", "abc"]);
    }
    #[test]
    fn responsive_layout_never_underflows_or_exceeds_terminal() {
        for width in 0..=160 {
            for height in 0..=50 {
                if let Some(layout) = Layout::new(width, height) {
                    assert!(layout.width < width);
                    assert_eq!(layout.sidebar + layout.content, layout.width);
                    assert!(layout.content >= 35 && layout.rows > 0);
                    assert!(3 + layout.rows <= height - 5);
                    assert_eq!(layout.sidebar > 0, width >= 72);
                }
            }
        }
    }
    #[test]
    fn editing_preserves_utf8_boundaries_and_paste_does_not_execute_lines() {
        let mut editor = Editor::default();
        editor.insert("你好a").unwrap();
        editor.left();
        editor.backspace();
        assert_eq!(editor.text, "你a");
        editor.delete();
        assert_eq!(editor.text, "你");
        editor.insert("\n/quit\x1b").unwrap();
        assert_eq!(editor.text, "你 /quit ");
        let previous = editor.text.clone();
        assert!(editor.insert(&"x".repeat(16 * 1024)).is_err());
        assert_eq!(editor.text, previous);
    }
}
