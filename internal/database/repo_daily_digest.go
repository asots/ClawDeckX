package database

import (
	"time"

	"gorm.io/gorm"
)

type DailyDigestRepo struct {
	db *gorm.DB
}

func NewDailyDigestRepo() *DailyDigestRepo {
	return &DailyDigestRepo{db: DB}
}

func (r *DailyDigestRepo) Create(record *DailyDigest) error {
	return r.db.Create(record).Error
}

// Recent returns the most recent N digest records (excluding previews if excludePreview).
func (r *DailyDigestRepo) Recent(limit int, excludePreview bool) ([]DailyDigest, error) {
	if limit <= 0 {
		limit = 10
	}
	q := r.db.Order("generated_at desc").Limit(limit)
	if excludePreview {
		q = q.Where("status <> ?", "preview")
	}
	var records []DailyDigest
	err := q.Find(&records).Error
	return records, err
}

// HasSentForDate checks whether a non-preview digest was already produced for a given date.
func (r *DailyDigestRepo) HasSentForDate(digestDate string) (bool, error) {
	var count int64
	err := r.db.Model(&DailyDigest{}).
		Where("digest_date = ? AND status IN ?", digestDate, []string{"success", "partial", "empty"}).
		Count(&count).Error
	return count > 0, err
}

// Cleanup keeps the latest maxKeep records and removes any older than the cutoff.
func (r *DailyDigestRepo) Cleanup(olderThan time.Duration, maxKeep int) error {
	var count int64
	r.db.Model(&DailyDigest{}).Count(&count)
	if count <= int64(maxKeep) {
		return nil
	}
	cutoff := time.Now().Add(-olderThan)
	return r.db.Where("generated_at < ?", cutoff).Delete(&DailyDigest{}).Error
}
