"""Compose actual app screenshots into a tutorial with FFmpeg; never recreate UI.

Inputs stay in ignored reports because invitation screens contain temporary credentials.
Requires Pillow, a CJK font, FFmpeg (libx264/palettegen), and the documented captures.
"""
import os
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
INPUT = Path(os.environ.get('PICKDROP_CAPTURE_DIR', ROOT / '.build/reports/readme-onboarding/real'))
WORK = ROOT / '.build/reports/readme-onboarding/composed'
OUTPUT = ROOT / 'assets/readme'
FONT = os.environ.get('PICKDROP_DEMO_FONT', '/System/Library/Fonts/STHeiti Medium.ttc')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
# Coordinates refer to the captured pixel dimensions, before crop/scale.
SCENES = [
    ('01-create.png', '电脑 · 创建群组', ['填写群名，点击「创建」。'], None, [], (52, 600, 536, 78)),
    ('02-group.png', '电脑 · 打开邀请', ['点击群聊右上角的', '「邀请 +」。'], None, [], (510, 150, 96, 56)),
    ('03-invite.png', '电脑 · 复制链接', ['点击「复制邀请链接」。', '手机也可以扫描此页二维码。'], None,
     [(185, 140, 270, 270), (70, 480, 500, 55), (70, 615, 500, 55)], (52, 708, 536, 80)),
    ('04-phone-home.png', '手机 · 加入群组', ['在手机首页点击', '「加入群组」。'], (0, 121, 1080, 1100), [], (415, 818, 250, 155)),
    ('06-phone-join-filled.png', '手机 · 申请加入', ['粘贴邀请链接。', '确认后点击「申请加入」。'], (40, 460, 1000, 1560),
     [(90, 820, 900, 140), (90, 1045, 900, 150), (90, 1285, 900, 125)], (80, 1828, 920, 148)),
    ('02-group.png', '电脑 · 查看申请', ['回到电脑，点击群名下方的', '设备在线数量一栏。'], None, [], (25, 83, 590, 60)),
    ('08-mac-approve.png', '电脑 · 允许加入', ['在「成员与加入申请」中', '核对设备名称，点击「允许」。'], None, [], (51, 360, 270, 82)),
    ('10-phone-success.png', '连接成功', ['在电脑发送一句话。', '手机收到消息，即可开始互传。'], (0, 121, 1080, 1000), [], None),
]


def ffmpeg(args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    for index, (filename, title, lines, crop, masks, focus) in enumerate(SCENES):
        source = INPUT / filename
        with Image.open(source) as capture:
            expected = (1080, 2400) if 'phone' in filename else (640, 840)
            if capture.size != expected:
                raise ValueError(f'{filename}: expected {expected}, got {capture.size}; recheck masks')
        background = Image.new('RGB', (1280, 960), '#f5f5f7')
        draw = ImageDraw.Draw(background)
        def text(x, y, content, size=26, color='#20252d'):
            draw.text((x, y), content, font=ImageFont.truetype(FONT, size), fill=color)
        text(48, 38, '拾传 · 开始使用', 26, '#68686e')
        text(48, 122, title, 40)
        for row, line in enumerate(lines):
            text(48, 198 + row * 43, line, 27)
        for step, scene in enumerate(SCENES):
            y = 365 + step * 58
            color = '#0879ef' if step == index else '#8a8f97'
            if step == index:
                draw.rounded_rectangle((36, y-8, 575, y+40), 10, fill='#e7f1ff')
            text(52, y, f'{step+1:02}   {scene[1]}', 25, color)
        text(48, 900, '同一可信局域网 · 两端保持运行', 23, '#68686e')
        if masks:
            text(700, 900, '演示邀请信息已遮挡', 21, '#68686e')
        base = WORK / f'base-{index}.png'
        background.save(base)
        filters = []
        for x, y, width, height in masks:
            filters.append(f'drawbox=x={x}:y={y}:w={width}:h={height}:color=0xe9edf2:t=fill')
        if focus:
            x, y, width, height = focus
            filters.append(f'drawbox=x={x}:y={y}:w={width}:h={height}:color=0x1684ff:t=5')
        if crop:
            x, y, width, height = crop
            filters.append(f'crop={width}:{height}:{x}:{y}')
        filters.append('scale=590:740:force_original_aspect_ratio=decrease')
        graph = '[1:v]' + ','.join(filters) + '[screen];[0:v][screen]overlay=x=650+(590-overlay_w)/2:y=130+(740-overlay_h)/2'
        ffmpeg(['-i', str(base), '-i', str(source), '-filter_complex', graph, '-frames:v', '1', str(WORK / f'step-{index+1}.png')])
    # Readable holds; short opacity fades introduce each screenshot without moving controls.
    clips = []
    for index in range(len(SCENES)):
        clip = WORK / f'clip-{index}.mp4'
        ffmpeg(['-loop', '1', '-i', str(WORK / f'step-{index+1}.png'), '-t', '3', '-r', '20',
                '-vf', 'fade=t=in:st=0:d=0.15', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', str(clip)])
        clips.append(f"file '{clip.name}'")
    playlist = WORK / 'clips.txt'
    playlist.write_text('\n'.join(clips) + '\n')
    ffmpeg(['-f', 'concat', '-safe', '1', '-i', str(playlist), '-c', 'copy', '-movflags', '+faststart', str(OUTPUT / 'onboarding.mp4')])
    ffmpeg(['-i', str(OUTPUT / 'onboarding.mp4'), '-filter_complex',
            'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
            '-loop', '0', str(OUTPUT / 'onboarding.gif')])
    # A static fallback is accessible without animation playback.
    ffmpeg(['-i', str(WORK / 'step-7.png'), '-frames:v', '1', str(OUTPUT / 'onboarding-poster.png')])
    print('Created 24-second actual-interface tutorial: GIF, MP4, static fallback.')


if __name__ == '__main__':
    main()
