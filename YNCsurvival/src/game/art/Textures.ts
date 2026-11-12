//  「마지막 등불」 임시 그래픽 - 이미지 파일 없이 코드로 그린다
//  색감: 화면 대부분은 짙은 남색·보라, 공격 이펙트는 따뜻한 주황·금색
//  나중에 Preloader 의 preload() 에서 같은 키로 픽셀 아트 이미지를 로드하면 그대로 교체된다
//  선명하게 보이도록 모든 그림은 ART_SCALE(2)배 크기로 그리고, 화면에는 artScale() 로 줄여서 표시한다
//  (아래 좌표와 크기는 모두 화면에 보이는 크기 기준)

import { ART_SCALE } from '../display';

export const PALETTE = {
    night: 0x0b0d22,        //  바닥 기본색
    darkness: 0x04040f,     //  어둠 오버레이
    purple: 0x2a1f4a,
    ember: 0xff8a2a,
    gold: 0xffd27a,
    wax: 0xe8dcc0,
    ash: 0x8a8790,
};

export const GROUND_TILE_SIZE = 512;
export const GROUND_VARIANTS = 4;

//  짐승 눈 위치 (스프라이트 중심 기준, 오른쪽을 보고 있을 때)
export const BEAST_EYE_OFFSET = {
    dog: { x: 11, y: -3 },
    wolf: { x: 13, y: -3 },
};

//  밀랍 순례자의 심지 위치 (탄환이 나가는 곳)
export const PILGRIM_WICK_OFFSET_Y = -28;

type Ctx = CanvasRenderingContext2D;

export function createTextures (scene: Phaser.Scene)
{
    for (let i = 0; i < GROUND_VARIANTS; i++)
    {
        canvas(scene, `ground${i}`, GROUND_TILE_SIZE, GROUND_TILE_SIZE, (ctx) => drawGround(ctx, 1000 + i * 77));
    }

    canvas(scene, 'player', 32, 40, drawPlayer);
    canvas(scene, 'dog', 34, 22, (ctx) => drawBeast(ctx, 34 / 34, 7));
    canvas(scene, 'wolf', 40, 26, (ctx) => drawBeast(ctx, 40 / 34, 11));
    canvas(scene, 'beastEyes', 10, 5, drawBeastEyes);
    canvas(scene, 'pilgrim', 48, 64, drawPilgrim);
    canvas(scene, 'moth', 120, 80, drawMoth);
    canvas(scene, 'eclipse', 240, 240, drawEclipse);
    canvas(scene, 'sunFace', 240, 240, drawSunFace);

    //  투사체 / 이펙트
    canvas(scene, 'wax', 16, 16, drawWaxBullet);
    canvas(scene, 'darkHand', 56, 40, drawDarkHand);
    radial(scene, 'ember', 16, [[0, '#fff3c4'], [0.35, '#ffa040'], [1, 'rgba(255,90,20,0)']]);
    radial(scene, 'emberPool', 128, [
        [0, 'rgba(255,170,70,0.55)'], [0.7, 'rgba(255,110,30,0.35)'],
        [0.9, 'rgba(255,205,110,0.75)'], [1, 'rgba(255,205,110,0)']
    ]);
    canvas(scene, 'gem', 10, 12, (ctx) => drawFlame(ctx, 10, 12));
    canvas(scene, 'gemBig', 16, 20, (ctx) => drawFlame(ctx, 16, 20));
    radial(scene, 'ash', 8, [[0, 'rgba(200,195,210,0.9)'], [1, 'rgba(160,155,170,0)']]);

    //  빛
    radial(scene, 'lightMask', 256, [[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    radial(scene, 'lanternGlow', 256, [[0, 'rgba(255,170,80,0.35)'], [0.5, 'rgba(255,140,60,0.14)'], [1, 'rgba(255,120,40,0)']]);
}

// ---------------------------------------------------------------- 도우미

function canvas (scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: Ctx) => void)
{
    if (scene.textures.exists(key))
    {
        return;     //  이미 이미지로 로드되어 있으면 그대로 사용
    }
    const tex = scene.textures.createCanvas(key, w * ART_SCALE, h * ART_SCALE)!;
    const ctx = tex.getContext();
    ctx.scale(ART_SCALE, ART_SCALE);
    draw(ctx);
    tex.refresh();
}

function radial (scene: Phaser.Scene, key: string, size: number, stops: [number, string][])
{
    canvas(scene, key, size, size, (ctx) => {
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        stops.forEach(([offset, color]) => g.addColorStop(offset, color));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
    });
}

//  같은 시드면 항상 같은 무늬가 나오는 난수
function seeded (seed: number)
{
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function ellipse (ctx: Ctx, x: number, y: number, rx: number, ry: number, color: string)
{
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
}

// ---------------------------------------------------------------- 바닥

function drawGround (ctx: Ctx, seed: number)
{
    const S = GROUND_TILE_SIZE;
    const rand = seeded(seed);

    ctx.fillStyle = '#0b0d22';
    ctx.fillRect(0, 0, S, S);

    //  보랏빛 얼룩 (타일 경계에 걸리지 않게 안쪽에만)
    for (let i = 0; i < 18; i++)
    {
        const r = 30 + rand() * 60;
        const x = r + rand() * (S - r * 2);
        const y = r + rand() * (S - r * 2);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(52,38,92,0.35)');
        g.addColorStop(1, 'rgba(52,38,92,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    //  갈라진 땅
    ctx.strokeStyle = 'rgba(4,4,14,0.9)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++)
    {
        let x = 40 + rand() * (S - 80);
        let y = 40 + rand() * (S - 80);
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let j = 0; j < 4; j++)
        {
            x += (rand() - 0.5) * 50;
            y += (rand() - 0.5) * 50;
            ctx.lineTo(Phaser.Math.Clamp(x, 4, S - 4), Phaser.Math.Clamp(y, 4, S - 4));
        }
        ctx.stroke();
    }

    //  말라 죽은 풀
    ctx.strokeStyle = 'rgba(86,74,128,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 70; i++)
    {
        const x = 6 + rand() * (S - 12);
        const y = 8 + rand() * (S - 12);
        ctx.beginPath();
        for (let j = 0; j < 3; j++)
        {
            ctx.moveTo(x + j * 2, y);
            ctx.lineTo(x + j * 2 + (rand() - 0.5) * 4, y - 3 - rand() * 4);
        }
        ctx.stroke();
    }

    //  돌
    for (let i = 0; i < 14; i++)
    {
        const x = 10 + rand() * (S - 20);
        const y = 10 + rand() * (S - 20);
        const r = 3 + rand() * 5;
        ellipse(ctx, x, y, r * 1.3, r, '#1a1833');
        ellipse(ctx, x - 1, y - r * 0.4, r * 0.8, r * 0.45, '#2b2750');
    }

    //  흩날린 재
    for (let i = 0; i < 90; i++)
    {
        ctx.fillStyle = `rgba(150,140,190,${0.1 + rand() * 0.2})`;
        ctx.fillRect(rand() * S, rand() * S, 1.5, 1.5);
    }
}

// ---------------------------------------------------------------- 등불지기 (오른쪽을 봄)

function drawPlayer (ctx: Ctx)
{
    //  망토
    ctx.fillStyle = '#3b2d5c';
    ctx.beginPath();
    ctx.moveTo(10, 15);
    ctx.lineTo(22, 15);
    ctx.lineTo(26, 38);
    ctx.lineTo(5, 38);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#2a1f45';
    ctx.fillRect(5, 35, 21, 3);

    //  후드
    ellipse(ctx, 16, 12, 9, 9.5, '#4a3872');
    ellipse(ctx, 17, 13.5, 5.5, 5.5, '#0a0812');
    //  후드 속 희미한 눈빛
    ctx.fillStyle = 'rgba(255,190,110,0.85)';
    ctx.fillRect(15, 13, 1.5, 1.5);
    ctx.fillRect(19, 13, 1.5, 1.5);

    //  등불을 든 팔
    ctx.strokeStyle = '#3b2d5c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(21, 19);
    ctx.lineTo(26, 24);
    ctx.stroke();

    //  등불
    ctx.strokeStyle = '#c9a24a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(27.5, 25, 2.5, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#c9a24a';
    ctx.fillRect(24, 26, 7, 1.5);
    ctx.fillRect(24, 34, 7, 1.5);
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(25, 27.5, 5, 6.5);
    ctx.fillStyle = '#fff1b8';
    ctx.fillRect(26.5, 29, 2, 3.5);
}

// ---------------------------------------------------------------- 그을린 짐승 (검은 연기 형체, 오른쪽을 봄)

function drawBeast (ctx: Ctx, s: number, seed: number)
{
    const rand = seeded(seed);
    const body = '#07060c';

    //  연기 꼬리
    ctx.strokeStyle = body;
    ctx.lineWidth = 3 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6 * s, 10 * s);
    ctx.quadraticCurveTo(1 * s, 9 * s, 2 * s, 4 * s);
    ctx.stroke();

    //  다리
    ctx.fillStyle = body;
    for (const x of [8, 12, 20, 23])
    {
        ctx.fillRect(x * s, 14 * s, 2.2 * s, 7 * s);
    }

    //  몸통 / 머리 / 주둥이 / 귀
    ellipse(ctx, 15 * s, 12 * s, 10.5 * s, 5.5 * s, body);
    ellipse(ctx, 26 * s, 9 * s, 5 * s, 4 * s, body);
    ellipse(ctx, 30.5 * s, 10.5 * s, 3.2 * s, 2 * s, body);
    ctx.beginPath();
    ctx.moveTo(23.5 * s, 7 * s);
    ctx.lineTo(24.5 * s, 1 * s);
    ctx.lineTo(27 * s, 6 * s);
    ctx.moveTo(26.5 * s, 6.5 * s);
    ctx.lineTo(29 * s, 1.5 * s);
    ctx.lineTo(29.5 * s, 7 * s);
    ctx.fill();

    //  피어오르는 연기
    for (let i = 0; i < 9; i++)
    {
        const x = (5 + rand() * 22) * s;
        const y = (5 + rand() * 5) * s;
        ellipse(ctx, x, y, (1.5 + rand() * 2.5) * s, (1.2 + rand() * 2) * s, `rgba(48,36,84,${0.35 + rand() * 0.3})`);
    }
}

function drawBeastEyes (ctx: Ctx)
{
    for (const x of [2.5, 7.5])
    {
        ellipse(ctx, x, 2.5, 2.5, 2.5, 'rgba(255,90,30,0.35)');
        ellipse(ctx, x, 2.5, 1.3, 1.1, '#ffb15c');
    }
}

// ---------------------------------------------------------------- 밀랍 순례자

function drawPilgrim (ctx: Ctx)
{
    const wax = '#e8dcc0';
    const shade = '#c4b28a';

    //  녹아내린 몸 (구부정한 사람 형태)
    ctx.fillStyle = wax;
    ctx.beginPath();
    ctx.moveTo(15, 24);
    ctx.quadraticCurveTo(24, 19, 34, 24);
    ctx.lineTo(41, 58);
    ctx.lineTo(7, 58);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(30, 24);
    ctx.lineTo(41, 58);
    ctx.lineTo(32, 58);
    ctx.closePath();
    ctx.fill();

    //  흘러내린 촛농
    for (const [x, y, rx, ry] of [[9, 59, 3, 4], [17, 61, 2.5, 3], [26, 60, 3, 4], [36, 61, 2.5, 3], [13, 40, 1.5, 4], [33, 36, 1.5, 5]])
    {
        ellipse(ctx, x, y, rx, ry, wax);
    }

    //  한쪽이 녹아내린 머리
    ellipse(ctx, 24, 16, 8.5, 9, '#efe5cc');
    ellipse(ctx, 18, 22, 3, 5, '#efe5cc');
    ellipse(ctx, 21, 16, 1.8, 2.8, '#3a2f25');
    ellipse(ctx, 27.5, 17, 1.8, 2.8, '#3a2f25');
    ellipse(ctx, 24.5, 21.5, 1.6, 1, '#5a4a38');

    //  심지 + 불꽃
    ctx.strokeStyle = '#2b2420';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(24, 8);
    ctx.lineTo(24, 4.5);
    ctx.stroke();
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.moveTo(24, 0);
    ctx.quadraticCurveTo(27, 3.5, 24, 5.5);
    ctx.quadraticCurveTo(21, 3.5, 24, 0);
    ctx.fill();
    ellipse(ctx, 24, 4, 1, 1.3, '#fff1b0');
}

// ---------------------------------------------------------------- 재의 나방 여왕

function drawMoth (ctx: Ctx)
{
    const wing = '#8a8790';
    const edge = '#5b5864';

    const drawWing = (points: number[][]) => {
        ctx.fillStyle = wing;
        ctx.strokeStyle = edge;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i += 2)
        {
            ctx.quadraticCurveTo(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    };

    //  위 날개 / 아래 날개 (좌우 대칭)
    for (const m of [1, -1])
    {
        const x = (v: number) => 60 + (v - 60) * m;
        drawWing([[x(60), 34], [x(30), 0], [x(6), 10], [x(0), 36], [x(56), 42]]);
        drawWing([[x(58), 44], [x(30), 50], [x(24), 74], [x(46), 72], [x(58), 52]]);

        //  날개 무늬 (눈알 모양)
        ellipse(ctx, x(30), 26, 8, 7, '#3d3a44');
        ellipse(ctx, x(30), 26, 4.5, 4, '#c9c3b8');
        ellipse(ctx, x(30), 26, 2, 2, '#2a2830');

        //  날개맥
        ctx.strokeStyle = 'rgba(70,66,80,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x(58), 36);
        ctx.lineTo(x(12), 14);
        ctx.moveTo(x(58), 38);
        ctx.lineTo(x(8), 32);
        ctx.moveTo(x(58), 48);
        ctx.lineTo(x(32), 68);
        ctx.stroke();

        //  더듬이
        ctx.strokeStyle = '#4a4752';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x(58), 18);
        ctx.quadraticCurveTo(x(52), 6, x(44), 3);
        ctx.stroke();
    }

    //  몸통
    ellipse(ctx, 60, 44, 6, 20, '#4a4752');
    ellipse(ctx, 60, 22, 6, 6, '#56535e');
    ellipse(ctx, 57.5, 21, 1.4, 1.4, '#ffcf8a');
    ellipse(ctx, 62.5, 21, 1.4, 1.4, '#ffcf8a');
}

// ---------------------------------------------------------------- 긴 밤 (일식) / 꺼져가는 옛 태양

function drawEclipse (ctx: Ctx)
{
    const c = 120;
    const corona = ctx.createRadialGradient(c, c, 88, c, c, 120);
    corona.addColorStop(0, 'rgba(255,214,140,0.5)');
    corona.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = corona;
    ctx.fillRect(0, 0, 240, 240);

    ellipse(ctx, c, c, 95, 95, '#020208');
    ctx.strokeStyle = 'rgba(255,214,140,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, 95, 0, Math.PI * 2);
    ctx.stroke();
}

function drawSunFace (ctx: Ctx)
{
    const c = 120;
    const glow = ctx.createRadialGradient(c, c, 60, c, c, 120);
    glow.addColorStop(0, 'rgba(255,170,60,0.45)');
    glow.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 240, 240);

    const disc = ctx.createRadialGradient(c, c - 20, 10, c, c, 95);
    disc.addColorStop(0, '#f2a050');
    disc.addColorStop(1, '#7a2e12');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(c, c, 95, 0, Math.PI * 2);
    ctx.fill();

    //  지쳐서 감긴 눈, 처진 눈썹, 작은 입
    ctx.strokeStyle = '#3b1408';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (const x of [92, 148])
    {
        ctx.beginPath();
        ctx.arc(x, 108, 14, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(76, 86); ctx.lineTo(104, 92);
    ctx.moveTo(164, 86); ctx.lineTo(136, 92);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, 162, 12, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();

    //  갈라진 일식 껍질 조각
    ctx.fillStyle = '#020208';
    const rand = seeded(42);
    for (let i = 0; i < 9; i++)
    {
        const a0 = (i / 9) * Math.PI * 2 + rand() * 0.2;
        const a1 = a0 + 0.35 + rand() * 0.25;
        ctx.beginPath();
        ctx.arc(c, c, 97, a0, a1);
        ctx.arc(c, c, 78 + rand() * 8, a1 - 0.05, a0 + 0.05, true);
        ctx.closePath();
        ctx.fill();
    }
    ctx.strokeStyle = '#020208';
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++)
    {
        const a = rand() * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * 92, c + Math.sin(a) * 92);
        ctx.lineTo(c + Math.cos(a + 0.1) * 70, c + Math.sin(a + 0.1) * 70);
        ctx.lineTo(c + Math.cos(a - 0.05) * 58, c + Math.sin(a - 0.05) * 58);
        ctx.stroke();
    }
}

// ---------------------------------------------------------------- 투사체

function drawWaxBullet (ctx: Ctx)
{
    ellipse(ctx, 8, 8, 6, 6, '#efe3c4');
    ellipse(ctx, 8, 13, 2, 2.5, '#efe3c4');
    ellipse(ctx, 6, 6, 2, 2, '#fffaf0');
}

//  어둠의 손아귀 (오른쪽을 향함)
function drawDarkHand (ctx: Ctx)
{
    ctx.shadowColor = 'rgba(150,100,230,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#120a1f';
    ellipse(ctx, 18, 20, 13, 11, '#120a1f');
    for (const [y, len] of [[10, 26], [16, 32], [23, 31], [30, 24]])
    {
        ctx.beginPath();
        ctx.moveTo(22, y - 3);
        ctx.quadraticCurveTo(22 + len * 0.7, y - 4, 22 + len, y + 1);
        ctx.quadraticCurveTo(22 + len * 0.7, y + 2, 22, y + 3);
        ctx.fill();
    }
}

//  경험치 불씨 (작은 불꽃)
function drawFlame (ctx: Ctx, w: number, h: number)
{
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.quadraticCurveTo(w, h * 0.6, w / 2, h);
    ctx.quadraticCurveTo(0, h * 0.6, w / 2, 0);
    ctx.fill();
    ellipse(ctx, w / 2, h * 0.68, w * 0.2, h * 0.2, '#fff2c0');
}
