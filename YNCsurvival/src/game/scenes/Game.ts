import { Scene } from 'phaser';

//  밸런스 수치 - 여기만 고치면 난이도 조절 가능
const WORLD_SIZE = 4000;

const PLAYER_SPEED = 200;
const PLAYER_MAX_HP = 100;
const PLAYER_INVULN_MS = 500;       //  피격 후 무적 시간

const ENEMY_SPEED = 80;
const ENEMY_HP = 3;
const ENEMY_CONTACT_DAMAGE = 10;
const ENEMY_MAX_COUNT = 300;

const SPAWN_INTERVAL_START_MS = 1000;   //  시작 시 적 생성 간격
const SPAWN_INTERVAL_MIN_MS = 150;      //  최소 생성 간격
const SPAWN_SPEEDUP_PER_SEC = 8;        //  1초마다 생성 간격이 줄어드는 양(ms)

const FIRE_INTERVAL_MS = 400;
const FIRE_RANGE = 500;
const BULLET_SPEED = 450;
const BULLET_DAMAGE = 1;
const BULLET_LIFE_MS = 1500;

type Sprite = Phaser.Physics.Arcade.Sprite;

export interface GameResult
{
    survivedMs: number;
    kills: number;
}

export class Game extends Scene
{
    player: Sprite;
    enemies: Phaser.Physics.Arcade.Group;
    bullets: Phaser.Physics.Arcade.Group;

    cursors: Phaser.Types.Input.Keyboard.CursorKeys;
    wasd: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;

    hpBar: Phaser.GameObjects.Graphics;
    timerText: Phaser.GameObjects.Text;
    killText: Phaser.GameObjects.Text;

    //  씬 재시작 시에도 초기화되도록 create()에서 값을 넣는다
    hp: number;
    kills: number;
    elapsedMs: number;
    spawnAccMs: number;
    nextFireAt: number;
    invulnUntil: number;
    isGameOver: boolean;

    constructor ()
    {
        super('Game');
    }

    create ()
    {
        this.hp = PLAYER_MAX_HP;
        this.kills = 0;
        this.elapsedMs = 0;
        this.spawnAccMs = 0;
        this.nextFireAt = 0;
        this.invulnUntil = 0;
        this.isGameOver = false;

        //  월드 & 바닥
        this.physics.world.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
        this.add.tileSprite(0, 0, WORLD_SIZE, WORLD_SIZE, 'ground').setOrigin(0);

        //  플레이어
        this.player = this.physics.add.sprite(WORLD_SIZE / 2, WORLD_SIZE / 2, 'player');
        this.player.setCollideWorldBounds(true);
        this.player.setDepth(10);

        this.cameras.main.setBounds(0, 0, WORLD_SIZE, WORLD_SIZE);
        this.cameras.main.startFollow(this.player, true);

        //  적 / 투사체는 오브젝트 풀로 재사용 (매번 생성·삭제하지 않음)
        this.enemies = this.physics.add.group({ maxSize: ENEMY_MAX_COUNT });
        this.bullets = this.physics.add.group({ maxSize: 100 });

        //  충돌 처리
        this.physics.add.overlap(this.bullets, this.enemies, (bullet, enemy) => {
            this.onBulletHitEnemy(bullet as Sprite, enemy as Sprite);
        });
        this.physics.add.overlap(this.player, this.enemies, () => {
            this.onPlayerHit(ENEMY_CONTACT_DAMAGE);
        });
        //  적끼리 서로 밀어내서 한 점에 겹치지 않게
        this.physics.add.collider(this.enemies, this.enemies);

        //  입력 (방향키 + WASD)
        const keyboard = this.input.keyboard!;
        this.cursors = keyboard.createCursorKeys();
        this.wasd = keyboard.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }) as Game['wasd'];

        this.createHud();
    }

    update (time: number, delta: number)
    {
        if (this.isGameOver)
        {
            return;
        }

        this.elapsedMs += delta;

        this.updatePlayerMovement();
        this.updateEnemies();
        this.updateSpawner(delta);
        this.updateAutoFire(time);
        this.updateBullets(time);
        this.updateHud();
    }

    // ---------------------------------------------------------------- 플레이어

    updatePlayerMovement ()
    {
        let dx = 0;
        let dy = 0;

        if (this.cursors.left.isDown || this.wasd.left.isDown) dx -= 1;
        if (this.cursors.right.isDown || this.wasd.right.isDown) dx += 1;
        if (this.cursors.up.isDown || this.wasd.up.isDown) dy -= 1;
        if (this.cursors.down.isDown || this.wasd.down.isDown) dy += 1;

        //  대각선 이동이 더 빨라지지 않도록 정규화
        const velocity = new Phaser.Math.Vector2(dx, dy).normalize().scale(PLAYER_SPEED);
        this.player.setVelocity(velocity.x, velocity.y);

        if (dx !== 0)
        {
            this.player.setFlipX(dx < 0);
        }
    }

    onPlayerHit (damage: number)
    {
        if (this.isGameOver || this.time.now < this.invulnUntil)
        {
            return;
        }

        this.hp = Math.max(0, this.hp - damage);
        this.invulnUntil = this.time.now + PLAYER_INVULN_MS;

        this.cameras.main.shake(100, 0.005);
        this.tweens.add({
            targets: this.player,
            alpha: 0.3,
            duration: 80,
            yoyo: true,
            repeat: 2,
            onComplete: () => this.player.setAlpha(1)
        });

        if (this.hp <= 0)
        {
            this.endGame();
        }
    }

    endGame ()
    {
        this.isGameOver = true;
        this.physics.pause();
        this.player.setTint(0xff0000);
        this.updateHud();

        const result: GameResult = { survivedMs: this.elapsedMs, kills: this.kills };
        this.time.delayedCall(1000, () => this.scene.start('GameOver', result));
    }

    // ---------------------------------------------------------------- 적

    updateSpawner (delta: number)
    {
        const elapsedSec = this.elapsedMs / 1000;
        const interval = Math.max(
            SPAWN_INTERVAL_MIN_MS,
            SPAWN_INTERVAL_START_MS - elapsedSec * SPAWN_SPEEDUP_PER_SEC
        );

        this.spawnAccMs += delta;
        while (this.spawnAccMs >= interval)
        {
            this.spawnAccMs -= interval;
            this.spawnEnemy();
        }
    }

    spawnEnemy ()
    {
        //  화면 바로 바깥의 원 위에서 랜덤 위치에 생성
        const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
        const distance = Math.hypot(this.scale.width, this.scale.height) / 2 + 40;
        const x = Phaser.Math.Clamp(this.player.x + Math.cos(angle) * distance, 0, WORLD_SIZE);
        const y = Phaser.Math.Clamp(this.player.y + Math.sin(angle) * distance, 0, WORLD_SIZE);

        const enemy = this.enemies.get(x, y, 'enemy') as Sprite | null;
        if (!enemy)
        {
            return;     //  풀이 가득 참 (최대 마릿수 도달)
        }

        enemy.enableBody(true, x, y, true, true);
        enemy.clearTint();
        enemy.setData('hp', ENEMY_HP);
    }

    updateEnemies ()
    {
        for (const obj of this.enemies.getChildren())
        {
            const enemy = obj as Sprite;
            if (enemy.active)
            {
                this.physics.moveToObject(enemy, this.player, ENEMY_SPEED);
            }
        }
    }

    onBulletHitEnemy (bullet: Sprite, enemy: Sprite)
    {
        if (!bullet.active || !enemy.active)
        {
            return;
        }

        bullet.disableBody(true, true);

        const hp = (enemy.getData('hp') as number) - BULLET_DAMAGE;
        enemy.setData('hp', hp);

        if (hp <= 0)
        {
            enemy.disableBody(true, true);
            this.kills++;
            return;
        }

        //  피격 시 잠깐 하얗게 번쩍
        enemy.setTintFill(0xffffff);
        this.time.delayedCall(60, () => enemy.clearTint());
    }

    // ---------------------------------------------------------------- 자동 공격

    updateAutoFire (time: number)
    {
        if (time < this.nextFireAt)
        {
            return;
        }

        const target = this.findNearestEnemy(FIRE_RANGE);
        if (!target)
        {
            return;
        }

        this.nextFireAt = time + FIRE_INTERVAL_MS;

        const bullet = this.bullets.get(this.player.x, this.player.y, 'bullet') as Sprite | null;
        if (!bullet)
        {
            return;
        }

        bullet.enableBody(true, this.player.x, this.player.y, true, true);
        bullet.setData('expireAt', time + BULLET_LIFE_MS);
        this.physics.moveToObject(bullet, target, BULLET_SPEED);
    }

    findNearestEnemy (maxDistance: number): Sprite | null
    {
        let nearest: Sprite | null = null;
        let nearestDistSq = maxDistance * maxDistance;

        for (const obj of this.enemies.getChildren())
        {
            const enemy = obj as Sprite;
            if (!enemy.active)
            {
                continue;
            }

            const distSq = Phaser.Math.Distance.Squared(this.player.x, this.player.y, enemy.x, enemy.y);
            if (distSq < nearestDistSq)
            {
                nearest = enemy;
                nearestDistSq = distSq;
            }
        }

        return nearest;
    }

    updateBullets (time: number)
    {
        for (const obj of this.bullets.getChildren())
        {
            const bullet = obj as Sprite;
            if (bullet.active && time >= (bullet.getData('expireAt') as number))
            {
                bullet.disableBody(true, true);
            }
        }
    }

    // ---------------------------------------------------------------- HUD

    createHud ()
    {
        const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
            fontFamily: 'Arial Black', fontSize: 24, color: '#ffffff',
            stroke: '#000000', strokeThickness: 5
        };

        //  setScrollFactor(0): 카메라가 움직여도 화면에 고정
        this.hpBar = this.add.graphics().setScrollFactor(0).setDepth(100);

        this.timerText = this.add.text(this.scale.width / 2, 20, '00:00', textStyle)
            .setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

        this.killText = this.add.text(this.scale.width - 20, 20, 'Kills: 0', textStyle)
            .setOrigin(1, 0).setScrollFactor(0).setDepth(100);

        this.updateHud();
    }

    updateHud ()
    {
        const barX = 20;
        const barY = 20;
        const barW = 200;
        const barH = 20;

        this.hpBar.clear();
        this.hpBar.fillStyle(0x000000, 0.6).fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
        this.hpBar.fillStyle(0x43a047).fillRect(barX, barY, barW * (this.hp / PLAYER_MAX_HP), barH);

        this.timerText.setText(formatTime(this.elapsedMs));
        this.killText.setText(`Kills: ${this.kills}`);
    }
}

export function formatTime (ms: number): string
{
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const sec = (totalSec % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
}
