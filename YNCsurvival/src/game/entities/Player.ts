import { ART_SCALE, artScale } from '../display';
import { DEPTH, PLAYER } from '../config';
import { HitEffects } from '../systems/Hazards';
import { PlayerStats } from '../systems/PlayerStats';

const SLOW_TINT = 0xd8cfae;     //  밀랍에 맞아 둔해졌을 때 색

//  등불지기: 후드를 뒤집어쓴 마지막 등불지기 가문의 후손
export class Player extends Phaser.Physics.Arcade.Sprite
{
    stats: PlayerStats;
    hp: number;
    invulnUntil = 0;
    private slowUntil = 0;
    private slowFactor = 1;
    private stunUntil = 0;

    constructor (scene: Phaser.Scene, x: number, y: number, stats: PlayerStats)
    {
        super(scene, x, y, 'player');
        scene.add.existing(this);
        scene.physics.add.existing(this);

        this.stats = stats;
        this.hp = stats.maxHp;
        this.setDepth(DEPTH.player).setScale(artScale());
        this.body!.setSize(18 * ART_SCALE, 30 * ART_SCALE);   //  몸통 판정 18x30 (텍스처 픽셀 기준이라 ART_SCALE 배)
    }

    //  등불이 있는 위치 (불씨 탄이 나가는 곳)
    get lanternX (): number
    {
        return this.x + (this.flipX ? -11 : 11);
    }

    get lanternY (): number
    {
        return this.y + 10;
    }

    //  dx, dy: -1 ~ 1 입력 방향
    move (dx: number, dy: number)
    {
        const now = this.scene.time.now;
        if (now < this.stunUntil)
        {
            this.setVelocity(0, 0);
            return;
        }

        const slowed = now < this.slowUntil;
        if (slowed) this.setTint(SLOW_TINT);
        else if (this.isTinted) this.clearTint();

        //  대각선 이동이 더 빨라지지 않도록 정규화
        const speed = this.stats.moveSpeed * (slowed ? this.slowFactor : 1);
        const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(speed);
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
        if (amount <= 0 || now < this.invulnUntil || this.hp <= 0)
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

    applyEffects (effects: HitEffects)
    {
        const now = this.scene.time.now;
        if (effects.slowMs)
        {
            this.slowFactor = effects.slowFactor ?? 0.5;
            this.slowUntil = Math.max(this.slowUntil, now + effects.slowMs);
        }
        if (effects.stunMs)
        {
            this.stunUntil = Math.max(this.stunUntil, now + effects.stunMs);
            this.setVelocity(0, 0);
        }
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
