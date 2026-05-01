package digest

// Setting keys used by the digest module. Centralised so handlers and the
// scheduler agree on the persistence contract.
const (
	KeyDigestEnabled        = "notify_digest_enabled"
	KeyDigestTime           = "notify_digest_time"            // "HH:MM" 24h, local TZ
	KeyDigestSkipIfEmpty    = "notify_digest_skip_if_empty"   // "true"/"false"
	KeyDigestCatchupHours   = "notify_digest_catchup_hours"   // integer string
	KeyDigestSections       = "notify_digest_sections"        // CSV of SectionID
	KeyDigestChannels       = "notify_digest_channels"        // CSV; empty -> all
	KeyDigestLastSentDate   = "notify_digest_last_sent_date"  // YYYY-MM-DD
	KeyDigestDreamProvider  = "notify_digest_dream_provider"  // reserved
)

// AllKeys returns every setting key the handler should accept on writes.
func AllKeys() []string {
	return []string{
		KeyDigestEnabled,
		KeyDigestTime,
		KeyDigestSkipIfEmpty,
		KeyDigestCatchupHours,
		KeyDigestSections,
		KeyDigestChannels,
		KeyDigestLastSentDate,
		KeyDigestDreamProvider,
	}
}
