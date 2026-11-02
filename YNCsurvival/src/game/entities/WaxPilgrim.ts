import { PILGRIM_WICK_OFFSET_Y } from '../art/Textures';
import { PILGRIM } from '../config';
import { Boss, BossContext } from './Boss';

//  중간 보스: 밀랍 순례자
//  빛을 찾아 걸어온 사람들이 촛농처럼 녹아 굳어버린 모습
//  일반 몬스터보다 느리지만 매우 단단하고, 머리 위 심지에서 녹은 밀랍을 느린 탄환으로 쏜다 (맞으면 둔화)
export class WaxPilgrim extends Boss
{
    readonly kind = 'pilgrim';
    private nextFireAt: number;

    constructor (ctx: BossContext, x: number, y: number, now: number)
    {
        super(ctx, x, y, 'pilgrim', PILGRIM.hp);
        this.xp = PILGRIM.xp;
        this.contactDamage = PILGRIM.contactDamage;
        this.body!.setSize(30, 52);
        this.nextFireAt = now + PILGRIM.fireIntervalMs;
    }

    update (now: number)
    {
        this.chase(PILGRIM.speed);
        this.setFlipX(this.ctx.player.x < this.x);

        if (now >= this.nextFireAt)
        {
            this.nextFireAt = now + PILGRIM.fireIntervalMs;
            this.fireWax();
        }

        this.drawHpBar();
    }

    private fireWax ()
    {
        const { player, hazards } = this.ctx;
        const wickY = this.y + PILGRIM_WICK_OFFSET_Y;
        const baseAngle = Phaser.Math.Angle.Between(this.x, wickY, player.x, player.y);
        const half = (PILGRIM.bulletCount - 1) / 2;

        for (let i = 0; i < PILGRIM.bulletCount; i++)
        {
            hazards.fireProjectile(this.x, wickY, baseAngle + (i - half) * PILGRIM.bulletSpreadRad, {
                texture: 'wax',
                speed: PILGRIM.bulletSpeed,
                damage: PILGRIM.bulletDamage,
                slowFactor: PILGRIM.slowFactor,
                slowMs: PILGRIM.slowMs
            });
        }

        //  쏘는 순간 몸이 살짝 늘어났다 돌아옴
        this.scene.tweens.add({ targets: this, scaleY: 1.12, duration: 90, yoyo: true });
    }
}
