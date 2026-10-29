import { XP, xpToNextLevel } from '../config';
import { Player } from '../entities/Player';

type Sprite = Phaser.Physics.Arcade.Sprite;

//  경험치 보석 드롭 / 흡수 / 레벨 계산
export class Experience
{
    level = 1;
    xp = 0;
    private gems: Phaser.Physics.Arcade.Group;

    constructor (
        private scene: Phaser.Scene,
        private player: Player,
        private onLevelUp: () => void
    )
    {
        this.gems = scene.physics.add.group({ maxSize: XP.maxGems });
    }

    get xpToNext (): number
    {
        return xpToNextLevel(this.level);
    }

    dropGem (x: number, y: number, value: number)
    {
        const texture = value >= 10 ? 'gemBig' : 'gem';
        const gem = this.gems.get(x, y, texture) as Sprite | null;
        if (!gem)
        {
            return;     //  바닥에 보석이 너무 많음
        }

        gem.setTexture(texture);    //  풀에서 재사용된 보석은 이전 텍스처가 남아 있을 수 있음
        gem.enableBody(true, x, y, true, true);
        gem.setData('value', value);
        gem.setDepth(5);
    }

    update ()
    {
        const magnetSq = XP.magnetRadius * XP.magnetRadius;
        const collectSq = XP.collectRadius * XP.collectRadius;

        for (const obj of this.gems.getChildren())
        {
            const gem = obj as Sprite;
            if (!gem.active)
            {
                continue;
            }

            const distSq = Phaser.Math.Distance.Squared(gem.x, gem.y, this.player.x, this.player.y);
            if (distSq <= collectSq)
            {
                gem.disableBody(true, true);
                this.gain(gem.getData('value') as number);
            }
            else if (distSq <= magnetSq)
            {
                this.scene.physics.moveToObject(gem, this.player, XP.pullSpeed);
            }
            else
            {
                gem.setVelocity(0, 0);
            }
        }
    }

    gain (amount: number)
    {
        this.xp += amount;
        while (this.xp >= this.xpToNext)
        {
            this.xp -= this.xpToNext;
            this.level++;
            this.onLevelUp();
        }
    }
}
