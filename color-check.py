# 草皮调色校验：对比「游戏截图」与「FC26 参考图」的草坪实测色（H/S/L）
# 用法: python color-check.py [我的截图.png] [参考图.jpg ...]
import subprocess, sys, os, re, colorsys, statistics
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()

def load(path):
    err = subprocess.run([FF,'-hide_banner','-i',path], capture_output=True, text=True).stderr
    m = re.search(r', (\d+)x(\d+)', err)
    W = int(m.group(1))
    out = os.path.join(os.environ.get('TEMP','/tmp'), 'cc.raw')
    subprocess.run([FF,'-y','-hide_banner','-loglevel','error','-i',path,
                    '-pix_fmt','rgb24','-f','rawvideo',out], check=True)
    return open(out,'rb').read(), W

def med(d, W, x0, x1, y0, y1):
    rs=[];gs=[];bs=[]
    for y in range(y0, y1):
        for x in range(x0, x1):
            i=(y*W+x)*3; rs.append(d[i]); gs.append(d[i+1]); bs.append(d[i+2])
    return (int(statistics.median(rs)), int(statistics.median(gs)), int(statistics.median(bs)))

def show(tag, c):
    h,l,s = colorsys.rgb_to_hls(c[0]/255, c[1]/255, c[2]/255)
    print(f'  {tag:16s} #{c[0]:02x}{c[1]:02x}{c[2]:02x}  H={h*360:5.1f}° S={s*100:4.1f}% L={l*100:4.1f}%')

if __name__ == '__main__':
    mine = sys.argv[1] if len(sys.argv) > 1 else 'pitch-mid.png'
    d, W = load(mine)
    print('=== 游戏画面 ===')
    show('近处草皮', med(d, W, 200, 1100, 290, 380))
    show('更近草皮', med(d, W, 250, 1000, 400, 455))
    for ref in sys.argv[2:]:
        print(f'=== 参考图 {os.path.basename(ref)} ===')
        t, W2 = load(ref)
        for (x0,x1,y0,y1,tag) in [(120,780,300,340,'中景'), (120,780,400,455,'近处')]:
            show(tag, med(t, W2, x0,x1,y0,y1))
