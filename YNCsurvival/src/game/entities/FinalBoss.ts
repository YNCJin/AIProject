import { FINAL_BOSS } from '../config';
import { Boss, BossContext } from './Boss';

const PLAYER_RADIUS = 12;   //  판정 시 플레이어 크기를 조금 반영
const FLASH_MS = 200;       //  발동 순간 번쩍이는 시간
const SCREEN_BAR_WIDTH = 500;

type AreaAttack =
    | { shape: 'circle'; x: number; y: number; radius: number; damage: number; startAt: number; hitAt: number }
    | { shape: 'rect'; x: number; y: number; angle: number; length: number; width: number; damage: number; startAt: number; hitAt: number };

//  최종 보스: 체력이 매우 높고, 느린 주기로 범위 공격
//  - 원형: 플레이어가 서 있던 위치를 중심으로 원
//  - 직사각형: 보스에서 플레이어 방향으로 길게 뻗는 띠
//  공격 전에 telegraphMs 동안 바닥에 범위가 차오르며 예고되고, 다 차는 순간 안에 있으면 피해
export class FinalBoss extends Boss
{
    readonly kind = 'final';
    readonly xp = 0;
    readonly contactDamage = FINAL_BOSS.contactDamage;

    private attack: AreaAttack | null = null;     //  예고 중인 공격
    private flash: AreaAttack | null = null;      //  방금 발동해서 번쩍이는 중인 공격 (표시만, 판정 없음)
    private nextAttackAt: number;
    private flashUntil = 0;
    private areaGfx: Phaser.GameObjects.Graphics;
    private screenBar: Phaser.GameObjects.Graphics;
    private nameText: Phaser.GameObjects.Text;

    constructor (ctx: BossContext, x: number, y: number, now: number)
    {
        super(ctx, x, y, 'finalBoss', FINAL_BOSS.hp);
        this.nextAttackAt = now + FINAL_BOSS.attackIntervalMs;

        //  범위 표시는 플레이어 / 적보다 아래(바닥)에 그림
        this.areaGfx = ctx.scene.add.graphics().setDepth(4);

        //  최종 보스 HP 는 화면 위쪽 큰 바로 표시
        const { width } = ctx.scene.scale;
        this.screenBar = ctx.scene.add.graphics().setScrollFactor(0).setDepth(100);
        this.nameText = ctx.scene.add.text(width / 2, 64, '최종 보스', {
            fontFamily: 'Arial Black', fontSize: 18, color: '#ffffff', stroke: '#000000', strokeThickness: 4
        }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);
    }

    update (now: number)
    {
        this.chase(FINAL_BOSS.speed);

        if (!this.attack && now >= this.nextAttackAt)
        {
            this.startAttack(now);
        }

        if (this.attack && now >= this.attack.hitAt)
        {
            this.resolveAttack(this.attack, now);   //  판정은 공격당 정확히 한 번
        }

        this.drawArea(now);
        this.drawHpBar();
    }

    private startAttack (now: number)
    {
        const { player } = this.ctx;
        const hitAt = now + FINAL_BOSS.telegraphMs;

        if (Math.random() < 0.5)
        {
            this.attack = {
                shape: 'circle', x: player.x, y: player.y, radius: FINAL_BOSS.circleRadius,
                damage: FINAL_BOSS.circleDamage, startAt: now, hitAt
            };
        }
        else
        {
            this.attack = {
                shape: 'rect', x: this.x, y: this.y,
                angle: Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y),
                length: FINAL_BOSS.rectLength, width: FINAL_BOSS.rectWidth,
                damage: FINAL_BOSS.rectDamage, startAt: now, hitAt
            };
        }
    }

    private resolveAttack (attack: AreaAttack, now: number)
    {
        if (this.isPlayerInside(attack))
        {
            this.ctx.hitPlayer(attack.damage);
        }

        this.scene.cameras.main.shake(150, 0.004);
        this.attack = null;
        this.flash = attack;
        this.flashUntil = now + FLASH_MS;
        this.nextAttackAt = now + FINAL_BOSS.attackIntervalMs;
    }

    private isPlayerInside (attack: AreaAttack): boolean
    {
        const { player } = this.ctx;
        const dx = player.x - attack.x;
        const dy = player.y - attack.y;

        if (attack.shape === 'circle')
        {
            const r = attack.radius + PLAYER_RADIUS;
            return dx * dx + dy * dy <= r * r;
        }

        //  플레이어 위치를 직사각형 기준 좌표로 회전시켜 판정
        const cos = Math.cos(attack.angle);
        const sin = Math.sin(attack.angle);
        const along = dx * cos + dy * sin;
        const across = -dx * sin + dy * cos;
        return along >= -PLAYER_RADIUS && along <= attack.length + PLAYER_RADIUS
            && Math.abs(across) <= attack.width / 2 + PLAYER_RADIUS;
    }

    //  예고: 옅은 범위 + 안쪽에서 차오르는 진한 영역 / 발동 직후: 번쩍임
    private drawArea (now: number)
    {
        const g = this.areaGfx;
        g.clear();

        if (this.flash)
        {
            if (now < this.flashUntil)
            {
                g.fillStyle(0xff5252, 0.6);
                this.fillShape(this.flash, 1);
            }
            else
            {
                this.flash = null;
            }
        }

        const attack = this.attack;
        if (!attack)
        {
            return;
        }

        const progress = (now - attack.startAt) / (attack.hitAt - attack.startAt);
        g.fillStyle(0xff1744, 0.15);
        this.fillShape(attack, 1);
        g.lineStyle(2, 0xff1744, 0.9);
        this.strokeShape(attack);
        g.fillStyle(0xff1744, 0.35);
        this.fillShape(attack, progress);
    }

    private fillShape (attack: AreaAttack, progress: number)
    {
        if (attack.shape === 'circle')
        {
            this.areaGfx.fillCircle(attack.x, attack.y, attack.radius * progress);
        }
        else
        {
            this.areaGfx.fillPoints(rectCorners(attack, attack.length * progress), true);
        }
    }

    private strokeShape (attack: AreaAttack)
    {
        if (attack.shape === 'circle')
        {
            this.areaGfx.strokeCircle(attack.x, attack.y, attack.radius);
        }
        else
        {
            this.areaGfx.strokePoints(rectCorners(attack, attack.length), true);
        }
    }

    protected drawHpBar ()
    {
        const { width } = this.scene.scale;
        const x = (width - SCREEN_BAR_WIDTH) / 2;
        const y = 90;

        this.screenBar.clear();
        this.screenBar.fillStyle(0x000000, 0.7).fillRect(x - 2, y - 2, SCREEN_BAR_WIDTH + 4, 18);
        this.screenBar.fillStyle(0xd50000).fillRect(x, y, SCREEN_BAR_WIDTH * (this.hp / this.maxHp), 14);
    }

    destroy (fromScene?: boolean)
    {
        this.areaGfx?.destroy();
        this.screenBar?.destroy();
        this.nameText?.destroy();
        super.destroy(fromScene);
    }
}

//  (x, y) 에서 angle 방향으로 length 만큼 뻗은, 폭 width 인 직사각형의 네 꼭짓점
function rectCorners (attack: { x: number; y: number; angle: number; width: number }, length: number)
{
    const cos = Math.cos(attack.angle);
    const sin = Math.sin(attack.angle);
    const hw = attack.width / 2;
    const px = -sin * hw;   //  진행 방향에 수직인 벡터
    const py = cos * hw;

    return [
        new Phaser.Math.Vector2(attack.x + px, attack.y + py),
        new Phaser.Math.Vector2(attack.x + cos * length + px, attack.y + sin * length + py),
        new Phaser.Math.Vector2(attack.x + cos * length - px, attack.y + sin * length - py),
        new Phaser.Math.Vector2(attack.x - px, attack.y - py)
    ];
}
