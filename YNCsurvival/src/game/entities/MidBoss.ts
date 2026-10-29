import { MID_BOSS } from '../config';
import { Boss, BossContext } from './Boss';

//  중간 보스: 플레이어를 천천히 쫓아오며 일정 주기마다 플레이어 방향으로 탄환을 부채꼴 발사
export class MidBoss extends Boss
{
    readonly kind = 'mid';
    readonly xp = MID_BOSS.xp;
    readonly contactDamage = MID_BOSS.contactDamage;
    private nextFireAt: number;

    constructor (ctx: BossContext, x: number, y: number, now: number)
    {
        super(ctx, x, y, 'midBoss', MID_BOSS.hp);
        this.setCircle(MID_BOSS.size / 2);
        this.nextFireAt = now + MID_BOSS.fireIntervalMs;
    }

    update (now: number)
    {
        this.chase(MID_BOSS.speed);

        if (now >= this.nextFireAt)
        {
            this.nextFireAt = now + MID_BOSS.fireIntervalMs;
            this.fireSpread();
        }

        this.drawHpBar();
    }

    private fireSpread ()
    {
        const { player } = this.ctx;
        const baseAngle = Phaser.Math.Angle.Between(this.x, this.y, player.x, player.y);
        const half = (MID_BOSS.bulletCount - 1) / 2;

        for (let i = 0; i < MID_BOSS.bulletCount; i++)
        {
            this.ctx.fireBullet(this.x, this.y, baseAngle + (i - half) * MID_BOSS.bulletSpreadRad);
        }

        //  발사 순간 살짝 커졌다 돌아오는 연출
        this.scene.tweens.add({ targets: this, scale: 1.15, duration: 80, yoyo: true });
    }
}
