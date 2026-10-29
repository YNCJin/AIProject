import { PLAYER } from '../config';
import { PlayerStats } from '../systems/PlayerStats';

export class Player extends Phaser.Physics.Arcade.Sprite
{
    stats: PlayerStats;
    hp: number;
    invulnUntil = 0;

    constructor (scene: Phaser.Scene, x: number, y: number, stats: PlayerStats)
    {
        super(scene, x, y, 'player');
        scene.add.existing(this);
        scene.physics.add.existing(this);

        this.stats = stats;
        this.hp = stats.maxHp;
        this.setCollideWorldBounds(true);
        this.setDepth(10);
    }

    //  dx, dy: -1 ~ 1 입력 방향
    move (dx: number, dy: number)
    {
        //  대각선 이동이 더 빨라지지 않도록 정규화
        const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(this.stats.moveSpeed);
        this.setVelocity(velocity.x, velocity.y);

        if (dx !== 0)
        {
            this.setFlipX(dx < 0);
        }
    }

    //  실제로 피해를 입었으면 true (무적 시간 중이면 false)
    takeDamage (amount: number): boolean
    {
        const now = this.scene.time.now;
        if (now < this.invulnUntil || this.hp <= 0)
        {
            return false;
        }

        this.hp = Math.max(0, this.hp - amount);
        this.invulnUntil = now + PLAYER.invulnMs;

        this.scene.tweens.add({
            targets: this,
            alpha: 0.3,
            duration: 80,
            yoyo: true,
            repeat: 2,
            onComplete: () => this.setAlpha(1)
        });

        return true;
    }

    heal (amount: number)
    {
        this.hp = Math.min(this.stats.maxHp, this.hp + amount);
    }

    get isDead (): boolean
    {
        return this.hp <= 0;
    }
}
