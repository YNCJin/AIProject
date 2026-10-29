import { Player } from './Player';

//  보스가 게임에 요청할 수 있는 것들 (BossManager 가 채워서 넘겨줌)
export interface BossContext
{
    scene: Phaser.Scene;
    player: Player;
    fireBullet: (x: number, y: number, angle: number) => void;
    hitPlayer: (damage: number) => void;
}

export type BossKind = 'mid' | 'final';

//  보스 공통 부모: 체력, 피격 번쩍임, 플레이어 추적, 머리 위 HP 바
//  now 는 게임 경과 시간(ms). 레벨업 일시정지 중에는 멈춰 있으므로 공격 주기가 꼬이지 않는다
export abstract class Boss extends Phaser.Physics.Arcade.Sprite
{
    abstract readonly kind: BossKind;
    abstract readonly xp: number;
    abstract readonly contactDamage: number;

    hp: number;
    readonly maxHp: number;
    protected hpBar: Phaser.GameObjects.Graphics;

    constructor (protected ctx: BossContext, x: number, y: number, texture: string, hp: number)
    {
        super(ctx.scene, x, y, texture);
        ctx.scene.add.existing(this);
        ctx.scene.physics.add.existing(this);

        this.hp = hp;
        this.maxHp = hp;
        this.setDepth(9);
        this.hpBar = ctx.scene.add.graphics().setDepth(12);
    }

    //  죽었으면 true
    takeDamage (amount: number): boolean
    {
        this.hp = Math.max(0, this.hp - amount);

        this.setTintFill(0xffffff);
        this.scene.time.delayedCall(60, () => this.active && this.clearTint());

        return this.hp <= 0;
    }

    protected chase (speed: number)
    {
        this.scene.physics.moveToObject(this, this.ctx.player, speed);
    }

    protected drawHpBar ()
    {
        const width = this.displayWidth;
        const x = this.x - width / 2;
        const y = this.y - this.displayHeight / 2 - 12;

        this.hpBar.clear();
        this.hpBar.fillStyle(0x000000, 0.7).fillRect(x - 1, y - 1, width + 2, 8);
        this.hpBar.fillStyle(0xffa726).fillRect(x, y, width * (this.hp / this.maxHp), 6);
    }

    abstract update (now: number): void;

    destroy (fromScene?: boolean)
    {
        this.hpBar?.destroy();
        super.destroy(fromScene);
    }
}
