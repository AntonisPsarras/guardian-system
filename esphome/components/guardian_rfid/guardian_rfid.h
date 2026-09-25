#pragma once

#include <functional>
#include <string>
#include <vector>

#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/i2c/i2c.h"
#include "esphome/core/automation.h"
#include "esphome/core/component.h"

namespace esphome {
namespace guardian_rfid {

class GuardianRfid;

class GuardianScanTrigger : public Trigger<> {
 public:
  explicit GuardianScanTrigger(GuardianRfid *parent);
};
class GuardianWriteBeginTrigger : public Trigger<> {
 public:
  explicit GuardianWriteBeginTrigger(GuardianRfid *parent);
};
class GuardianTagRemovedTrigger : public Trigger<> {
 public:
  explicit GuardianTagRemovedTrigger(GuardianRfid *parent);
};

// NTAG21x user-memory authenticator on an MFRC522, plus MIFARE Classic 1K
// (SAK 0x08/0x18/0x09/0x19) storing the same 36-byte GDN1 payload in sector 1
// blocks 4–6. HMAC-SHA256(master, uid || card_id || counter)[:16] is the
// credential on both media.
//
// Layout (4-byte pages, packed into Classic 16-byte blocks):
//   4     magic "GDN1"
//   5     version (1) + 3 reserved
//   6-7   card_id (8 bytes)
//   8     counter uint32 BE
//   9-12  HMAC-SHA256(master, uid || card_id || counter)[:16]
//
// Confidentiality of that payload differs by medium, and the difference is
// real rather than cosmetic:
//
//   NTAG21x  PWD/PACK derived from the master key and the UID, AUTH0 = page 4
//            with PROT = 1, so the payload cannot even be READ without a
//            password only this key can produce.
//   Classic  sector 1 is keyed with per-card diversified keys, also derived
//            from the master key and the UID (see derive_classic_keys_). A
//            card still on the factory transport key FFFFFFFFFFFF is upgraded
//            in place on its next successful scan, so existing cards need no
//            re-enrollment. Access bits stay at the transport value: only the
//            keys become secret. Rewriting access bits is the one operation
//            here that can brick a sector permanently and it buys nothing
//            once both keys are secret.
//
// Crypto1 is still broken. Diversified keys raise a Classic card from "opens
// with the published default key, instant dump" to "needs a nested/darkside
// attack against a card the attacker physically holds". That is a real
// improvement, not parity with NTAG. The rolling counter is what bounds a
// clone that does get made.
class GuardianRfid : public PollingComponent, public i2c::I2CDevice {
 public:
  void setup() override;
  void dump_config() override;
  void update() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_source(const std::string &source) { this->source_ = source; }
  void set_master_key_hex(const std::string &hex);
  void set_enrollment_sensor(binary_sensor::BinarySensor *sens) { this->enrollment_ = sens; }
  void set_allow_transport_key(bool allow) { this->allow_transport_key_ = allow; }

  void add_on_scan_callback(std::function<void()> &&f) { this->scan_callbacks_.push_back(std::move(f)); }
  void add_on_write_begin_callback(std::function<void()> &&f) {
    this->write_begin_callbacks_.push_back(std::move(f));
  }
  void add_on_tag_removed_callback(std::function<void()> &&f) {
    this->removed_callbacks_.push_back(std::move(f));
  }

  const std::string &source() const { return this->source_; }
  const std::string &result() const { return this->result_; }
  const std::string &card_id_hex() const { return this->card_id_hex_; }
  uint32_t counter() const { return this->counter_; }
  bool rotated() const { return this->rotated_; }
  uint8_t uid_bytes() const { return this->uid_len_; }
  // False means this card's payload can be READ by any reader: an NTAG with no
  // password set, or a MIFARE Classic still on the public transport key. The
  // credential is a bearer token, so a readable payload is a clonable card.
  // Exposed so Home Assistant can tell a household which of their keys are in
  // that state instead of the reader silently treating them as equivalent.
  bool tag_protected() const { return this->ntag_protected_; }

 protected:
  enum Status : uint8_t {
    ST_OK = 0,
    ST_TIMEOUT,
    ST_ERROR,
    ST_NAK,
    ST_CRC,
    ST_COLLISION,
    ST_UNSUPPORTED,
  };

  void pcd_write_(uint8_t reg, uint8_t value);
  void pcd_write_(uint8_t reg, const uint8_t *values, uint8_t count);
  uint8_t pcd_read_(uint8_t reg);
  void pcd_read_(uint8_t reg, uint8_t *values, uint8_t count);
  void pcd_set_bit_(uint8_t reg, uint8_t mask);
  void pcd_clear_bit_(uint8_t reg, uint8_t mask);
  void pcd_antenna_on_();
  void pcd_antenna_off_();
  void pcd_soft_reset_();
  void pcd_init_();
  void pcd_stop_crypto1_();
  bool pcd_crc_(const uint8_t *data, uint8_t len, uint8_t *out2);
  // RxCRCEn is off in RxModeReg (see pcd_init_), so the PCD does not check
  // CRC_A for us. Every response we act on has to be checked here instead.
  bool check_crc_a_(const uint8_t *frame, uint8_t len);
  Status pcd_transceive_(const uint8_t *send, uint8_t send_len, uint8_t *recv, uint8_t *recv_len,
                         uint8_t tx_last_bits = 0);
  Status pcd_mf_authent_(uint8_t auth_cmd, uint8_t block, const uint8_t key[6]);

  Status picc_request_a_();
  Status picc_select_(uint8_t *sak);
  Status picc_hlta_();
  bool reselect_();
  Status ntag_read_(uint8_t page, uint8_t *out16);
  Status ntag_write_(uint8_t page, const uint8_t in4[4]);
  Status ntag_pwd_auth_(const uint8_t pwd[4], uint8_t pack[2]);
  Status ntag_get_version_(uint8_t *out8);
  Status mifare_write_block_(uint8_t block, const uint8_t in16[16]);

  // Every derivation can fail - mbedtls context allocation, or a UID outside
  // the 4..10 bytes ISO 14443-3 allows. On failure the output buffers are left
  // untouched rather than filled with uninitialised stack, and `*ok` / the
  // return value is false. Callers MUST check: on the verify path a bad
  // derivation is merely fail-closed, but on a WRITE path it burns a garbage
  // MAC onto a card that then passes its own read-back check.
  bool hmac_sha256_(const uint8_t *data, size_t len, uint8_t out32[32]);
  void derive_pwd_pack_(uint8_t pwd[4], uint8_t pack[2], bool *ok);
  void derive_classic_keys_(uint8_t key_a[6], uint8_t key_b[6], bool *ok);
  bool compute_mac_(const uint8_t card_id[8], uint32_t counter, uint8_t mac16[16]);
  bool verify_mac_(const uint8_t card_id[8], uint32_t counter, const uint8_t mac16[16]);
  bool fill_payload_(const uint8_t card_id[8], uint32_t counter, uint8_t pages[9][4]);
  bool write_payload_(const uint8_t pages[9][4]);
  Status read_payload_(uint8_t pages[9][4]);
  Status classic_read_payload_(uint8_t pages[9][4]);
  bool classic_write_payload_(const uint8_t pages[9][4]);
  // Write the rotated payload for `next`, stash that target so a later poll
  // can finish or recognise it, and either fire ok/rotated or defer. When
  // fire_ok_on_fill_fail is true the card already verified and a failed MAC
  // derivation must not become a security verdict.
  void attempt_rotate_write_(const uint8_t card_id[8], uint32_t next, bool fire_ok_on_fill_fail);
  // GDN1 present, MAC for the on-card counter failed. Heal a torn rotate
  // (MAC matches counter-1 or counter+1) or retry a stashed write. Returns
  // true if it fired or deferred — caller must not then fire bad_mac.
  bool heal_torn_payload_(const uint8_t card_id[8], uint32_t counter, const uint8_t mac[16]);
  static uint32_t next_counter_(uint32_t counter);
  // ST_OK, ST_NAK (every key rejected — a verdict), or ST_TIMEOUT (the card
  // could not be re-selected between attempts — a link error, retry it).
  Status classic_authenticate_();
  bool classic_upgrade_trailer_();
  void maybe_upgrade_classic_();
  bool protect_ntag_();
  bool authenticate_ntag_();
  uint8_t cfg0_page_() const;
  bool enrollment_on_() const;
  // True when st is a frame-level failure AND the retry budget is not spent,
  // in which case the caller must return WITHOUT firing a scan so the next
  // poll re-reads the same tag. Once the budget is spent it returns false and
  // the caller reports a verdict as before.
  bool transient_(const char *what, Status st);
  const char *status_name_(Status st) const;
  void fire_scan_(const char *result, bool rotated = false);
  // Write failed while the tag is still on the coil. Retry on the next poll
  // without telling Home Assistant: a write_fail event used to grant passage
  // and a later ok/rotated event could persist a counter the card never kept.
  void defer_write_fail_();
  void latch_published_uid_();
  void clear_published_uid_();
  bool same_published_uid_(const uint8_t *uid, uint8_t len) const;
  void handle_selected_(uint8_t sak);
  void consume_payload_(uint8_t pages[9][4], bool have, bool ntag_pwd_ok);
  bool is_mifare_classic_sak_(uint8_t sak) const;
  bool same_uid_(const uint8_t *uid, uint8_t len) const;

  std::string source_;
  uint8_t master_key_[32]{0};
  bool have_key_{false};
  // Accept a MIFARE Classic card still on the published transport key. True by
  // default because refusing it makes factory-blank Classic enrollment
  // impossible and strands every card not yet upgraded. See __init__.py.
  bool allow_transport_key_{true};
  binary_sensor::BinarySensor *enrollment_{nullptr};

  std::vector<std::function<void()>> scan_callbacks_;
  std::vector<std::function<void()>> write_begin_callbacks_;
  std::vector<std::function<void()>> removed_callbacks_;

  uint8_t uid_[10]{0};
  uint8_t uid_len_{0};
  uint8_t current_uid_[10]{0};
  uint8_t current_uid_len_{0};
  bool have_current_{false};
  bool pending_retry_{false};
  // Last rotate we tried to commit. Survives a lift so a retap can finish a
  // torn write (Classic mixed-MAC cannot be healed from the on-card bytes
  // alone). Cleared on a successful ok/rotated, or when a different card_id
  // verifies. Not a second credential — the MAC still has to match.
  uint8_t retry_card_id_[8]{0};
  uint32_t retry_next_counter_{0};
  bool have_retry_target_{false};
  // Survives the short have_current_ drop (two WUPA misses) so a flaky HALT
  // cannot issue a second ok/rotated for the same physical tap. Cleared after
  // more consecutive misses, long enough that a real lift-and-retap is a new
  // presentation rather than a skip.
  uint8_t published_uid_[10]{0};
  uint8_t published_uid_len_{0};
  bool scan_published_{false};
  uint8_t presence_misses_{0};
  uint8_t storage_size_{0x0F};
  bool have_version_{false};
  bool picc_classic_{false};
  // Whether the payload just read was behind a secret: an NTAG PWD_AUTH that
  // succeeded, or a Classic sector opened with the diversified key. Reset per
  // scan by handle_selected_ so a previous card's answer can never carry over.
  bool ntag_protected_{false};
  // This card authenticated with the public transport key, so its sector
  // trailer still has to be upgraded to the diversified keys.
  bool classic_legacy_key_{false};
  // Set by transient_(): the scan ended in a garbled frame, nothing was
  // reported, and this UID must not be latched.
  bool link_error_{false};
  uint8_t transient_retries_{0};
  uint8_t select_fails_{0};

  std::string result_;
  std::string card_id_hex_;
  uint32_t counter_{0};
  bool rotated_{false};
};

}  // namespace guardian_rfid
}  // namespace esphome
