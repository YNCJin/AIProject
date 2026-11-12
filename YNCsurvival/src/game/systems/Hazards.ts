import { artScale, viewRect } from '../display';
import { DEPTH } from '../config';
import { Player } from '../entities/Player';

type Sprite = Phaser.Physics.Arcade.Sprite;

//  피격 시 추가 효과
export interface HitEffects
{
    slowFactor?: number;    //  둔화 시 이동 속도 배율
    slowMs?: number;
    stunMs?: number;        //  잠깐 움직이지 못함
}

export type HitHandler = (damage: number, effects: HitEffects) => void;

export interface ProjectileOptions extends HitEffects
{
    texture: string;
    speed: number;
    damage: number;
    lifeMs?: number;
    rotate?: boolean;       //  날아가는 방향으로 그림을 돌릴지
}

//  예고 후 발동하는 범위 공격의 모양
export type AreaShape =
    | { shape: 'circle'; x: number; y: number; radius: number }
    | { shape: 'rect'; x: number; y: number; angle: number; length: number; width: number }
    | { shape: 'sector'; x: number; y: number; angle: number; radius: number; spread: number }
    | { shape: 'full' };    //  맵 전체 (피할 수 없음)

export type AreaOptions = AreaShape & HitEffects & {
    telegraphMs: number;
    damage: number;         //  0 이면 경고 표시만 (나방 돌진 경로 등)
    color?: number;
    onResolve?: () => void;
};

interface Area
{
    opts: AreaOptions;
    startAt: number;
    hitAt: number;
    flashUntil: number;
    resolved: boolean;
}

const FLASH_MS = 200;
const PLAYER_RADIUS = 12;
const PROJECTILE_LIFE_MS = 5000;

//  보스가 쓰는 공격(투사체, 예고 범위)을 한곳에서 관리하고, 플레이어 피격 판정을 한다
//  now 는 게임 경과 시간이라 레벨업 일시정지 중에는 공격도 멈춘다
export class Hazards
{
    private projectiles: Phaser.Physics.Arcade.Group;
    private areas: Area[] = [];
    private gfx: Phaser.GameObjects.Graphics;
    private now = 0;

    constructor (private scene: Phaser.Scene, private player: Player, private onHit: HitHandler)
    {
        this.projectiles = scene.physics.add.group({ maxSize: 300 });
        this.gfx = scene.add.graphics().setDepth(DEPTH.hazardArea);

        scene.physics.add.overlap(player, this.projectiles, (_player, obj) => {
            const p = obj as Sprite;
            if (!p.active)
            {
                return;
            }
            p.disableBody(true, true);
            this.onHit(p.getData('damage') as number, p.getData('effects') as HitEffects);
        });
    }

    fireProjectile (x: number, y: number, angle: number, opts: ProjectileOptions)
    {
        const p = this.projectiles.get(x, y, opts.texture) as Sprite | null;
        if (!p)
        {
            return;
        }

        p.setTexture(opts.texture);
        p.enableBody(true, x, y, true, true);
        p.body!.setSize(p.width * 0.7, p.height * 0.7);
        p.setDepth(DEPTH.projectile).setScale(artScale());
        p.setRotation(opts.rotate ? angle : 0);
        p.setData('damage', opts.damage);
        p.setData('effects', { slowFactor: opts.slowFactor, slowMs: opts.slowMs, stunMs: opts.stunMs });
        p.setData('expireAt', this.now + (opts.lifeMs ?? PROJECTILE_LIFE_MS));
        this.scene.physics.velocityFromRotation(angle, opts.speed, p.body!.velocity);
    }

    addArea (opts: AreaOptions)
    {
        this.areas.push({ opts, startAt: this.now, hitAt: this.now + opts.telegraphMs, flashUntil: 0, resolved: false });
    }

    clear ()
    {
        this.areas = [];
        this.gfx.clear();
        for (const obj of this.projectiles.getChildren())
        {
            (obj as Sprite).disableBody(true, true);
        }
    }

    update (now: number)
    {
        this.now = now;

        for (const obj of this.projectiles.getChildren())
        {
            const p = obj as Sprite;
            if (p.active && now >= (p.getData('expireAt') as number))
            {
                p.disableBody(true, true);
            }
        }

        this.gfx.clear();
        for (const area of this.areas)
        {
            if (!area.resolved && now >= area.hitAt)
            {
                this.resolve(area);
            }
            this.draw(area);
        }
        this.areas = this.areas.filter((a) => !a.resolved || now < a.flashUntil);
    }

    // ---------------------------------------------------------------- 판정

    private resolve (area: Area)
    {
        area.resolved = true;
        area.flashUntil = this.now + FLASH_MS;
        const { opts } = area;

        if (opts.damage > 0 && this.isInside(opts))
        {
            this.onHit(opts.damage, opts);
        }
        if (opts.damage > 0)
        {
            this.scene.cameras.main.shake(120, 0.003);
        }
        opts.onResolve?.();
    }

    private isInside (opts: AreaShape): boolean
    {
        if (opts.shape === 'full')
        {
            return true;
        }

        const dx = this.player.x - opts.x;
        const dy = this.player.y - opts.y;

        switch (opts.shape)
        {
            case 'circle':
            {
                const r = opts.radius + PLAYER_RADIUS;
                return dx * dx + dy * dy <= r * r;
            }
            case 'rect':
            {
                //  플레이어 위치를 직사각형 기준 좌표로 돌려서 판정
                const cos = Math.cos(opts.angle);
                const sin = Math.sin(opts.angle);
                const along = dx * cos + dy * sin;
                const across = -dx * sin + dy * cos;
                return along >= -PLAYER_RADIUS && along <= opts.length + PLAYER_RADIUS
                    && Math.abs(across) <= opts.width / 2 + PLAYER_RADIUS;
            }
            case 'sector':
            {
                const dist = Math.sqrt(dx * dx + dy * dy);
                const diff = Phaser.Math.Angle.Wrap(Math.atan2(dy, dx) - opts.angle);
                return dist <= opts.radius + PLAYER_RADIUS && Math.abs(diff) <= opts.spread / 2;
            }
        }
    }

    // ---------------------------------------------------------------- 그리기

    //  예고: 옅은 범위 + 테두리 + 안쪽부터 차오르는 진한 영역 / 발동 직후: 번쩍임
    private draw (area: Area)
    {
        const { opts } = area;
        const g = this.gfx;
        const color = opts.color ?? 0xff4d2e;
        const warningOnly = opts.damage <= 0;

        if (area.resolved)
        {
            if (!warningOnly)
            {
                g.fillStyle(0xffc070, 0.55);
                this.fill(opts, 1);
            }
            return;
        }

        const progress = (this.now - area.startAt) / (area.hitAt - area.startAt);
        g.fillStyle(color, warningOnly ? 0.1 : 0.14);
        this.fill(opts, 1);
        g.lineStyle(2, color, 0.9);
        this.stroke(opts);
        g.fillStyle(color, warningOnly ? 0.18 : 0.32);
        this.fill(opts, progress);
    }

    private fill (opts: AreaShape, progress: number)
    {
        const g = this.gfx;
        switch (opts.shape)
        {
            case 'circle':
                g.fillCircle(opts.x, opts.y, opts.radius * progress);
                break;
            case 'rect':
                g.fillPoints(rectCorners(opts, opts.length * progress), true);
                break;
            case 'sector':
                g.beginPath();
                g.slice(opts.x, opts.y, opts.radius * progress, opts.angle - opts.spread / 2, opts.angle + opts.spread / 2);
                g.fillPath();
                break;
            case 'full':
            {
                const view = viewRect(this.scene);
                g.fillRect(view.x, view.y, view.width, view.height * progress);
                break;
            }
        }
    }

    private stroke (opts: AreaShape)
    {
        const g = this.gfx;
        switch (opts.shape)
        {
            case 'circle':
                g.strokeCircle(opts.x, opts.y, opts.radius);
                break;
            case 'rect':
                g.strokePoints(rectCorners(opts, opts.length), true);
                break;
            case 'sector':
                g.beginPath();
                g.slice(opts.x, opts.y, opts.radius, opts.angle - opts.spread / 2, opts.angle + opts.spread / 2);
                g.strokePath();
                break;
            case 'full':
            {
                const view = viewRect(this.scene);
                g.strokeRect(view.x + 4, view.y + 4, view.width - 8, view.height - 8);
                break;
            }
        }
    }
}

//  (x, y) 에서 angle 방향으로 length 만큼 뻗은, 폭 width 인 직사각형의 네 꼭짓점
function rectCorners (r: { x: number; y: number; angle: number; width: number }, length: number)
{
    const cos = Math.cos(r.angle);
    const sin = Math.sin(r.angle);
    const px = -sin * r.width / 2;
    const py = cos * r.width / 2;
    return [
        new Phaser.Math.Vector2(r.x + px, r.y + py),
        new Phaser.Math.Vector2(r.x + cos * length + px, r.y + sin * length + py),
        new Phaser.Math.Vector2(r.x + cos * length - px, r.y + sin * length - py),
        new Phaser.Math.Vector2(r.x - px, r.y - py)
    ];
}
