import { artScale } from '../display';
import { DEPTH } from '../config';
import { Hazards } from '../systems/Hazards';
import { Lighting } from '../world/Lighting';
import { Player } from './Player';

//  보스가 게임에 요청할 수 있는 것들 (BossManager 가 채워서 넘겨줌)
export interface BossContext
{
    scene: Phaser.Scene;
    player: Player;
    hazards: Hazards;       //  탄환 / 예고 범위 공격
    lighting: Lighting;     //  빛 범위 (나방 여왕의 재 가루 등)
    announce: (message: string, color: string) => void;
}

export type BossKind = 'pilgrim' | 'moth' | 'final';

//  보스 공통 부모: 체력, 피격 번쩍임, 플레이어 추적, 머리 위 HP 바 / 이름표
//  now 는 게임 경과 시간(ms). 레벨업 일시정지 중에는 멈춰 있으므로 공격 주기가 꼬이지 않는다
export abstract class Boss extends Phaser.Physics.Arcade.Sprite
{
    abstract readonly kind: BossKind;
    xp = 0;
    contactDamage = 0;
    hp: number;
    maxHp: number;
    protected hpBar: Phaser.GameObjects.Graphics;
    protected label?: Phaser.GameObjects.Text;

    constructor (protected ctx: BossContext, x: number, y: number, texture: string, hp: number)
    {
        super(ctx.scene, x, y, texture);
        ctx.scene.add.existing(this);
        ctx.scene.physics.add.existing(this);

        this.hp = hp;
        this.maxHp = hp;
        this.setDepth(DEPTH.boss).setScale(artScale());
        this.hpBar = ctx.scene.add.graphics().setDepth(DEPTH.boss);
    }

    //  죽었으면 true
    takeDamage (amount: number): boolean
    {
        this.hp = Math.max(0, this.hp - amount);

        this.setTintFill(0xffd9a0);
        this.scene.time.delayedCall(60, () => this.active && this.restoreTint());

        return this.hp <= 0;
    }

    //  피격 번쩍임이 끝난 뒤 원래 색으로 (최종 보스 3페이즈처럼 색을 쓰는 보스는 덮어씀)
    protected restoreTint ()
    {
        this.clearTint();
    }

    protected chase (speed: number)
    {
        this.scene.physics.moveToObject(this, this.ctx.player, speed);
    }

    protected showLabel (text: string)
    {
        this.label = this.scene.add.text(this.x, this.y, text, {
            fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#e8e2f0', align: 'center',
            stroke: '#000000', strokeThickness: 3
        }).setOrigin(0.5, 1).setDepth(DEPTH.boss);
    }

    protected drawHpBar ()
    {
        const width = Math.max(48, this.displayWidth * 0.8);
        const x = this.x - width / 2;
        const y = this.y - this.displayHeight / 2 - 10;

        this.hpBar.clear();
        this.hpBar.fillStyle(0x000000, 0.7).fillRect(x - 1, y - 1, width + 2, 7);
        this.hpBar.fillStyle(0xffa64d).fillRect(x, y, width * (this.hp / this.maxHp), 5);
        this.label?.setPosition(this.x, y - 3);
    }

    abstract update (now: number): void;

    //  물리 이동이 반영된 뒤(POST_UPDATE)에 호출: HP 바 / 이름표를 몸 위치에 맞춤
    render ()
    {
        this.drawHpBar();
    }

    destroy (fromScene?: boolean)
    {
        this.hpBar?.destroy();
        this.label?.destroy();
        super.destroy(fromScene);
    }
}
