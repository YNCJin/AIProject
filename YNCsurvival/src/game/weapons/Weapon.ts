import { WEAPONS, WeaponId } from '../data/weapons';
import { Player } from '../entities/Player';
import { Targets } from '../systems/Targets';
import { PlayerStats } from '../systems/PlayerStats';

//  무기가 게임에서 필요로 하는 것들
export interface WeaponContext
{
    scene: Phaser.Scene;
    player: Player;
    stats: PlayerStats;
    targets: Targets;      //  일반 몬스터 + 보스
}

//  모든 무기의 공통 부모. 새 무기는 이 클래스를 상속해서 update() 만 구현하면 된다
//  데미지는 반드시 stats.damageMultiplier, 쿨다운은 stats.cooldownMultiplier 를 곱해서 패시브가 적용되도록 할 것
export abstract class Weapon
{
    abstract readonly id: WeaponId;
    level = 1;

    constructor (protected ctx: WeaponContext)
    {
    }

    get name (): string
    {
        return WEAPONS[this.id].name;
    }

    get isMaxLevel (): boolean
    {
        return this.level >= WEAPONS[this.id].maxLevel;
    }

    levelUp ()
    {
        if (!this.isMaxLevel)
        {
            this.level++;
        }
    }

    abstract update (time: number, delta: number): void;
}
