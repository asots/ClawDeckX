package database

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"ClawDeckX/internal/i18n"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/webconfig"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

var DB *gorm.DB

func Init(cfg webconfig.DatabaseConfig, debug bool) error {
	var dialector gorm.Dialector

	switch cfg.Driver {
	case "sqlite":
		if err := os.MkdirAll(filepath.Dir(cfg.SQLitePath), 0o755); err != nil {
			return fmt.Errorf("failed to create database directory: %w", err)
		}
		// ── SQLite 稳定性 pragma ────────────────────────────────────────────────
		// 之前只 `sqlite.Open(path)` 默认跑 journal_mode=DELETE + 无 busy_timeout +
		// synchronous=FULL，这组默认在 Windows 上跑多连接 + FTS5 触发器时
		// 极易出现 SQLITE_CORRUPT_VTAB (267, "database disk image is malformed")：
		//   - DELETE 模式每次写都重建 journal，崩溃时 FTS shadow 表半写入
		//   - 无 busy_timeout → 并发写瞬间 SQLITE_BUSY，可能在 FTS5 写 shadow
		//     表中途返回错误，留下"索引已写一半"的坏状态
		//   - FULL 同步慢 + Windows 杀软扫描 *.db-journal 加剧
		// 调整后（通过 DSN query string 让 modernc/glebarez 驱动在 OPEN 时就应用）：
		//   - journal_mode=WAL   : 单写多读，跨进程更稳；崩溃恢复只重放 WAL 一次
		//   - synchronous=NORMAL : WAL 下 NORMAL 等价于 FULL 的持久化（FSYNC on commit）
		//                          同时避免每次写都 fsync，显著降低 Win 上的锁竞争
		//   - busy_timeout=10000 : 并发写互相等最多 10s 再返回 BUSY，杜绝"半写入"
		//   - foreign_keys=on    : 保证 FK CASCADE 行为一致
		dsn := cfg.SQLitePath + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(on)"
		dialector = sqlite.Open(dsn)
		logger.DB.Info().Str("driver", "sqlite").Str("path", cfg.SQLitePath).Msg(i18n.T(i18n.MsgLogDbInit))
	case "postgres":
		if cfg.PostgresDSN == "" {
			return fmt.Errorf("postgres_dsn is required when driver is postgres")
		}
		dialector = postgres.Open(cfg.PostgresDSN)
		logger.DB.Info().Str("driver", "postgres").Msg(i18n.T(i18n.MsgLogDbInit))
	default:
		return fmt.Errorf("unsupported database driver: %s", cfg.Driver)
	}

	logLevel := gormlogger.Silent
	if debug {
		logLevel = gormlogger.Info
	}

	var err error
	DB, err = gorm.Open(dialector, &gorm.Config{
		Logger: gormlogger.Default.LogMode(logLevel),
	})
	if err != nil {
		return fmt.Errorf("failed to connect database: %w", err)
	}

	// Configure connection pool
	sqlDB, err := DB.DB()
	if err != nil {
		return fmt.Errorf("failed to get underlying sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	if err := autoMigrate(); err != nil {
		return fmt.Errorf("failed to migrate database: %w", err)
	}

	logger.DB.Info().Msg(i18n.T(i18n.MsgLogDbInitComplete))
	return nil
}

func autoMigrate() error {
	return DB.AutoMigrate(
		&User{},
		&Activity{},
		&Alert{},
		&AuditLog{},
		&MonitorState{},
		&SnapshotRecord{},
		&Setting{},
		&CredentialScan{},
		&ConnectionLog{},
		&SkillHash{},
		&GatewayProfile{},
		&GatewayLifecycle{},
		&Template{},
		&SkillTranslation{},
		&ReleaseNotesTranslation{},
		// AgentRoom
		&AgentRoom{},
		&AgentRoomRoleProfile{},
		&AgentRoomMember{},
		&AgentRoomMessage{},
		&AgentRoomFact{},
		&AgentRoomTask{},
		&AgentRoomIntervention{},
		&AgentRoomAudit{},
		&AgentRoomDoc{},
		&AgentRoomDocChunk{},
		// v0.6
		&AgentRoomArtifact{},
		&AgentRoomPlaybook{},
		&AgentRoomPersonaMemory{},
		// v0.7 真实会议环节
		&AgentRoomAgendaItem{},
		&AgentRoomOpenQuestion{},
		&AgentRoomParkingLot{},
		&AgentRoomRisk{},
		&AgentRoomVote{},
		&AgentRoomVoteBallot{},
		&AgentRoomRetro{},
	)
}

func Close() error {
	if DB == nil {
		return nil
	}
	sqlDB, err := DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}
