#include "guardian_rfid.h"

#include "esphome/core/helpers.h"
#include "esphome/core/log.h"

#include "esp_random.h"
#include "mbedtls/md.h"

#include <cstdlib>
#include <cstring>

namespace esphome {
namespace guardian_rfid {

static const char *const TAG = "guardian_rfid";

// MFRC522 registers (datasheet addresses, not the SPI-shifted form).
static const uint8_t REG_COMMAND = 0x01;
static const uint8_t REG_COM_IRQ = 0x04;
static const uint8_t REG_DIV_IRQ = 0x05;
static const uint8_t REG_ERROR = 0x06;
static const uint8_t REG_STATUS2 = 0x08;
static const uint8_t REG_FIFO_DATA = 0x09;
static const uint8_t REG_FIFO_LEVEL = 0x0A;
static const uint8_t REG_CONTROL = 0x0C;
static const uint8_t REG_BIT_FRAMING = 0x0D;
static const uint8_t REG_COLL = 0x0E;
static const uint8_t REG_MODE = 0x11;
static const uint8_t REG_TX_MODE = 0x12;
static const uint8_t REG_RX_MODE = 0x13;
static const uint8_t REG_TX_CONTROL = 0x14;
static const uint8_t REG_TX_ASK = 0x15;
static const uint8_t REG_RX_SEL = 0x17;
static const uint8_t REG_CRC_H = 0x21;
static const uint8_t REG_CRC_L = 0x22;
static const uint8_t REG_MOD_WIDTH = 0x24;
static const uint8_t REG_T_MODE = 0x2A;
static const uint8_t REG_T_PRESCALER = 0x2B;
static const uint8_t REG_T_RELOAD_H = 0x2C;
static const uint8_t REG_T_RELOAD_L = 0x2D;
static const uint8_t REG_VERSION = 0x37;

static const uint8_t PCD_IDLE = 0x00;
static const uint8_t PCD_CALC_CRC = 0x03;
static const uint8_t PCD_TRANSCEIVE = 0x0C;
static const uint8_t PCD_MF_AUTHENT = 0x0E;
static const uint8_t PCD_SOFT_RESET = 0x0F;

static const uint8_t PICC_REQA = 0x26;
static const uint8_t PICC_WUPA = 0x52;
static const uint8_t PICC_SEL_CL1 = 0x93;
static const uint8_t PICC_SEL_CL2 = 0x95;
static const uint8_t PICC_HLTA = 0x50;
static const uint8_t PICC_READ = 0x30;
static const uint8_t PICC_MF_WRITE = 0xA0;
static const uint8_t PICC_UL_WRITE = 0xA2;
static const uint8_t PICC_GET_VERSION = 0x60;  // same byte as MF AUTH Key A; NTAG Transceive only
static const uint8_t PICC_MF_AUTH_A = 0x60;
static const uint8_t PICC_MF_AUTH_B = 0x61;
static const uint8_t PICC_PWD_AUTH = 0x1B;

static const uint8_t PAGE_MAGIC = 4;
static const char MAGIC[4] = {'G', 'D', 'N', '1'};
static const uint8_t PAYLOAD_VERSION = 1;
// Sector 0 is UID/manufacturer. GDN1 lives in sector 1 data blocks 4-6; the
// trailer is block 7 and holds Key A, the access bytes, and Key B.
static const uint8_t CLASSIC_BLOCK0 = 4;
static const uint8_t CLASSIC_TRAILER = 7;
static const uint8_t CLASSIC_TRANSPORT_KEY[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
// Transport access bytes + GPB, reused verbatim when the keys are replaced.
// All three data blocks stay at 000 (read/write with either key). See the
// class comment: only the KEYS become secret. Recomputing access bits is the
// one write here that can brick a sector for good, and with both keys derived
// from the master key it would add nothing.
static const uint8_t CLASSIC_ACCESS_BYTES[4] = {0xFF, 0x07, 0x80, 0x69};
// Consecutive frame-level failures tolerated on one tag before the driver
// stops retrying silently and reports a verdict.
static const uint8_t MAX_TRANSIENT_RETRIES = 3;
// Polls a PICC may answer WUPA but fail SELECT before that is reported once.
static const uint8_t SELECT_FAIL_REPORT_AT = 6;
// Two misses (~500 ms doorbell / 1 s portal) is enough to fire on_tag_removed
// and drop have_current_. The published-UID latch needs more: a HALT/WUPA
// glitch of two misses used to look like a lift, then the still-present tag
// was rotated a second time. Four misses (~1 s / 2 s) is still a short wait
// after a real lift before a retap is a new presentation.
static const uint8_t PRESENCE_DROP_MISSES = 2;
static const uint8_t PUBLISHED_DROP_MISSES = 4;

static bool picc_ack_ok(const uint8_t *recv, uint8_t recv_len) {
  if (recv_len >= 1 && ((recv[0] & 0x0A) == 0x0A || (recv[0] & 0xA0) == 0xA0))
    return true;
  return recv_len == 0;  // some clones ACK as empty
}

static std::string to_hex(const uint8_t *data, size_t n) {
  static const char *const kHex = "0123456789abcdef";
  std::string out;
  out.resize(n * 2);
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = kHex[data[i] >> 4];
    out[i * 2 + 1] = kHex[data[i] & 0x0f];
  }
  return out;
}

static uint32_t be32(const uint8_t *p) {
  return (uint32_t) p[0] << 24 | (uint32_t) p[1] << 16 | (uint32_t) p[2] << 8 | (uint32_t) p[3];
}

static void put_be32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t) (v >> 24);
  p[1] = (uint8_t) (v >> 16);
  p[2] = (uint8_t) (v >> 8);
  p[3] = (uint8_t) v;
}

GuardianScanTrigger::GuardianScanTrigger(GuardianRfid *parent) {
  parent->add_on_scan_callback([this]() { this->trigger(); });
}
GuardianWriteBeginTrigger::GuardianWriteBeginTrigger(GuardianRfid *parent) {
  parent->add_on_write_begin_callback([this]() { this->trigger(); });
}
GuardianTagRemovedTrigger::GuardianTagRemovedTrigger(GuardianRfid *parent) {
  parent->add_on_tag_removed_callback([this]() { this->trigger(); });
}

void GuardianRfid::set_master_key_hex(const std::string &hex) {
  if (hex.size() != 64)
    return;
  for (size_t i = 0; i < 32; i++) {
    char byte[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    this->master_key_[i] = (uint8_t) strtoul(byte, nullptr, 16);
  }
  this->have_key_ = true;
}

void GuardianRfid::setup() {
  this->pcd_soft_reset_();
  // CommandReg bit 4 is PowerDown. Stock rc522 waits until it clears (up to
  // a few 50 ms retries) before touching analog registers. A single delay(50)
  // can leave the PCD half-up; version then reads 0x00/0xFF and we mark_failed.
  uint32_t start = millis();
  while ((uint32_t) (millis() - start) < 150) {
    if ((this->pcd_read_(REG_COMMAND) & 0x10) == 0)
      break;
    delay(10);
  }
  delay(50);
  this->pcd_init_();
  uint8_t ver = this->pcd_read_(REG_VERSION);
  ESP_LOGI(TAG, "MFRC522 version 0x%02X source=%s", ver, this->source_.c_str());
  if (ver == 0x00 || ver == 0xFF) {
    ESP_LOGE(TAG, "MFRC522 not responding on I2C");
    this->mark_failed();
  }
}

void GuardianRfid::dump_config() {
  ESP_LOGCONFIG(TAG, "Guardian RFID authenticator:");
  ESP_LOGCONFIG(TAG, "  Source: %s", this->source_.c_str());
  LOG_I2C_DEVICE(this);
  LOG_UPDATE_INTERVAL(this);
}

void GuardianRfid::pcd_write_(uint8_t reg, uint8_t value) { this->write_byte(reg, value); }

void GuardianRfid::pcd_write_(uint8_t reg, const uint8_t *values, uint8_t count) {
  this->write_bytes(reg, values, count);
}

uint8_t GuardianRfid::pcd_read_(uint8_t reg) {
  uint8_t value = 0;
  this->read_byte(reg, &value);
  return value;
}

void GuardianRfid::pcd_read_(uint8_t reg, uint8_t *values, uint8_t count) {
  this->read_bytes(reg, values, count);
}

void GuardianRfid::pcd_set_bit_(uint8_t reg, uint8_t mask) {
  this->pcd_write_(reg, (uint8_t) (this->pcd_read_(reg) | mask));
}

void GuardianRfid::pcd_clear_bit_(uint8_t reg, uint8_t mask) {
  this->pcd_write_(reg, (uint8_t) (this->pcd_read_(reg) & ~mask));
}

void GuardianRfid::pcd_antenna_on_() {
  uint8_t v = this->pcd_read_(REG_TX_CONTROL);
  if ((v & 0x03) != 0x03)
    this->pcd_write_(REG_TX_CONTROL, (uint8_t) (v | 0x03));
}

void GuardianRfid::pcd_antenna_off_() {
  uint8_t v = this->pcd_read_(REG_TX_CONTROL);
  if (v & 0x03)
    this->pcd_write_(REG_TX_CONTROL, (uint8_t) (v & ~0x03));
}

void GuardianRfid::pcd_soft_reset_() { this->pcd_write_(REG_COMMAND, PCD_SOFT_RESET); }

void GuardianRfid::pcd_stop_crypto1_() {
  // miguelbalboa PCD_StopCrypto1: Classic MFAuthent leaves Status2Reg MFCrypto1On.
  this->pcd_clear_bit_(REG_STATUS2, 0x08);
}

void GuardianRfid::pcd_init_() {
  this->pcd_write_(REG_TX_MODE, 0x00);
  // RxNoErr: ignore <4-bit streams; RxIRq only when FIFO has data. CRC off, 106 kBd.
  this->pcd_write_(REG_RX_MODE, 0x08);
  this->pcd_write_(REG_MOD_WIDTH, 0x26);
  // UARTSel = internal analog (reset), RxWait = 8 bit-clocks (~75 µs), under ISO FDT.
  this->pcd_write_(REG_RX_SEL, 0x88);
  // TAuto, ~25 µs ticks, 1000 ticks = 25 ms timeout.
  this->pcd_write_(REG_T_MODE, 0x80);
  this->pcd_write_(REG_T_PRESCALER, 0xA9);
  this->pcd_write_(REG_T_RELOAD_H, 0x03);
  this->pcd_write_(REG_T_RELOAD_L, 0xE8);
  this->pcd_write_(REG_TX_ASK, 0x40);
  this->pcd_write_(REG_MODE, 0x3D);
  // Leave RFCfgReg at reset 33 dB. Forcing 48 dB made TX ringing look like a frame.
  this->pcd_antenna_off_();
}

bool GuardianRfid::pcd_crc_(const uint8_t *data, uint8_t len, uint8_t *out2) {
  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  this->pcd_write_(REG_DIV_IRQ, 0x04);
  this->pcd_write_(REG_FIFO_LEVEL, 0x80);
  this->pcd_write_(REG_FIFO_DATA, data, len);
  this->pcd_write_(REG_COMMAND, PCD_CALC_CRC);
  uint32_t start = millis();
  while ((uint32_t) (millis() - start) < 30) {
    if (this->pcd_read_(REG_DIV_IRQ) & 0x04) {
      this->pcd_write_(REG_COMMAND, PCD_IDLE);
      out2[0] = this->pcd_read_(REG_CRC_L);
      out2[1] = this->pcd_read_(REG_CRC_H);
      return true;
    }
    delay(1);
  }
  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  return false;
}

bool GuardianRfid::check_crc_a_(const uint8_t *frame, uint8_t len) {
  // Anything shorter than one payload byte plus CRC_A is not a checkable frame.
  if (frame == nullptr || len < 3)
    return false;
  uint8_t want[2];
  if (!this->pcd_crc_(frame, (uint8_t) (len - 2), want))
    return false;
  // pcd_crc_ returns CRC_L then CRC_H, which is transmission order.
  return want[0] == frame[len - 2] && want[1] == frame[len - 1];
}

GuardianRfid::Status GuardianRfid::pcd_transceive_(const uint8_t *send, uint8_t send_len, uint8_t *recv,
                                                    uint8_t *recv_len, uint8_t tx_last_bits) {
  // Stock rc522 waits 1 ms between antenna-on and PCD commands; the same gap
  // covers ISO 14443 frame-delay before SELECT after REQA.
  delayMicroseconds(1000);

  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  this->pcd_write_(REG_COM_IRQ, 0x7F);
  this->pcd_write_(REG_FIFO_LEVEL, 0x80);
  this->pcd_write_(REG_FIFO_DATA, send, send_len);
  this->pcd_write_(REG_BIT_FRAMING, tx_last_bits);
  this->pcd_write_(REG_COMMAND, PCD_TRANSCEIVE);
  this->pcd_set_bit_(REG_BIT_FRAMING, 0x80);

  uint32_t start = millis();
  // Stock await_transceive_ does not sample ComIrqReg for ≥2 ms after StartSend.
  // Immediate RxIRq with FIFOLevel=0 is a documented phantom (RxNoErr=0) and was
  // aborting SELECT after a real ATQA.
  while ((uint32_t) (millis() - start) < 2)
    delay(1);

  uint8_t n = 0;
  while ((uint32_t) (millis() - start) < 40) {
    n = this->pcd_read_(REG_COM_IRQ);
    // RxIRq (0x20) / IdleIRq (0x10) win even if TimerIRq (0x01) is also set, but
    // only when the FIFO actually holds a frame. Checking the timer first dropped
    // a valid ATQA/SAK on the 25 ms edge.
    if (n & 0x30) {
      uint8_t err = this->pcd_read_(REG_ERROR);
      if (err & 0x1B) {
        // ProtocolErr=0x01, ParityErr=0x02, CollErr=0x08, BufferOvfl=0x10.
        //
        // CollErr used to be missing from this mask. Only one PICC is ever in
        // this field, so a collision here is not two cards - it is a marginally
        // coupled tag whose bit stream the PCD could not resolve, and the FIFO
        // then holds plausible-looking garbage. Accepting that was how a valid
        // NTAG's SAK could arrive reading like a MIFARE Classic SAK and send
        // the tag down a branch it cannot answer.
        this->pcd_write_(REG_COMMAND, PCD_IDLE);
        ESP_LOGD(TAG, "RFID xfer cmd=0x%02X error err=0x%02X irq=0x%02X", send[0], err, n);
        return (err & 0x08) ? ST_COLLISION : ST_ERROR;
      }
      uint8_t fifo = this->pcd_read_(REG_FIFO_LEVEL);
      if (fifo == 0) {
        uint8_t last_bits = (uint8_t) (this->pcd_read_(REG_CONTROL) & 0x07);
        ESP_LOGD(TAG, "RFID xfer cmd=0x%02X empty fifo irq=0x%02X err=0x%02X rxlast=%u", send[0], n, err,
                 (unsigned) last_bits);
        this->pcd_write_(REG_COM_IRQ, 0x20);  // clear RxIRq; stay in Transceive
        if (n & 0x01) {
          this->pcd_write_(REG_COMMAND, PCD_IDLE);
          ESP_LOGD(TAG, "RFID xfer cmd=0x%02X timeout(timer) irq=0x%02X", send[0], n);
          return ST_TIMEOUT;
        }
        delay(1);
        continue;
      }
      uint8_t cap = *recv_len;
      uint8_t scratch[18];
      uint8_t to_read = fifo > sizeof(scratch) ? (uint8_t) sizeof(scratch) : fifo;
      this->pcd_read_(REG_FIFO_DATA, scratch, to_read);
      uint8_t to_copy = to_read < cap ? to_read : cap;
      if (to_copy > 0 && recv != nullptr)
        memcpy(recv, scratch, to_copy);
      *recv_len = to_copy;
      this->pcd_write_(REG_COMMAND, PCD_IDLE);
      // Braced because ESP_LOGD compiles to nothing above DEBUG, which leaves
      // this `if` with an empty body and makes it the one -Wempty-body warning
      // in the whole build. The warning is harmless here and that is the
      // problem: the first time this firmware was ever compiled it produced
      // exactly one warning, and a build with one accepted warning is a build
      // where the second one is not noticed.
      if (send[0] != PICC_REQA && send[0] != PICC_WUPA) {
        ESP_LOGD(TAG, "RFID xfer cmd=0x%02X ok fifo=%u cap=%u copied=%u", send[0], (unsigned) fifo, (unsigned) cap,
                 (unsigned) to_copy);
      }
      return ST_OK;
    }
    if (n & 0x01) {
      this->pcd_write_(REG_COMMAND, PCD_IDLE);
      ESP_LOGD(TAG, "RFID xfer cmd=0x%02X timeout(timer) irq=0x%02X", send[0], n);
      return ST_TIMEOUT;
    }
    delay(1);
  }
  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  ESP_LOGD(TAG, "RFID xfer cmd=0x%02X timeout(loop) irq=0x%02X", send[0], n);
  return ST_TIMEOUT;
}

GuardianRfid::Status GuardianRfid::pcd_mf_authent_(uint8_t auth_cmd, uint8_t block, const uint8_t key[6]) {
  if (this->uid_len_ < 4)
    return ST_ERROR;

  uint8_t send[12];
  send[0] = auth_cmd;
  send[1] = block;
  memcpy(send + 2, key, 6);
  memcpy(send + 8, this->uid_ + this->uid_len_ - 4, 4);

  delayMicroseconds(1000);
  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  this->pcd_write_(REG_COM_IRQ, 0x7F);
  this->pcd_write_(REG_FIFO_LEVEL, 0x80);
  this->pcd_write_(REG_FIFO_DATA, send, sizeof(send));
  this->pcd_write_(REG_BIT_FRAMING, 0x00);
  // MFAuthent starts itself. Do not set StartSend (BitFramingReg 0x80) — that
  // bit is Transceive-only. Do not reuse pcd_transceive_: AUTH completes on
  // IdleIRq with no FIFO frame; RxIRq+empty must not be treated as terminal.
  this->pcd_write_(REG_COMMAND, PCD_MF_AUTHENT);

  uint32_t start = millis();
  uint8_t n = 0;
  while ((uint32_t) (millis() - start) < 40) {
    n = this->pcd_read_(REG_COM_IRQ);
    if (n & 0x10) {  // IdleIRq: AUTH finished (success or ProtocolErr)
      uint8_t err = this->pcd_read_(REG_ERROR);
      this->pcd_write_(REG_COMMAND, PCD_IDLE);
      if (err & 0x13) {
        ESP_LOGD(TAG, "RFID classic AUTH cmd=0x%02X block=%u error err=0x%02X irq=0x%02X", auth_cmd,
                 (unsigned) block, err, n);
        return ST_ERROR;
      }
      if ((this->pcd_read_(REG_STATUS2) & 0x08) == 0) {
        ESP_LOGD(TAG, "RFID classic AUTH cmd=0x%02X block=%u crypto-off irq=0x%02X", auth_cmd, (unsigned) block, n);
        return ST_ERROR;
      }
      return ST_OK;
    }
    if (n & 0x01) {
      this->pcd_write_(REG_COMMAND, PCD_IDLE);
      ESP_LOGD(TAG, "RFID classic AUTH cmd=0x%02X block=%u timeout(timer) irq=0x%02X", auth_cmd, (unsigned) block, n);
      return ST_TIMEOUT;
    }
    delay(1);
  }
  this->pcd_write_(REG_COMMAND, PCD_IDLE);
  ESP_LOGD(TAG, "RFID classic AUTH cmd=0x%02X block=%u timeout(loop) irq=0x%02X", auth_cmd, (unsigned) block, n);
  return ST_TIMEOUT;
}

GuardianRfid::Status GuardianRfid::picc_request_a_() {
  this->pcd_clear_bit_(REG_COLL, 0x80);
  // WUPA, not REQA: update() always HLTA at the end of a poll. A PICC in HALT
  // must not answer REQA, so a held tag looked absent, have_current_ cleared,
  // and the next poll was a second rotate/enroll. WUPA wakes IDLE and HALT.
  uint8_t cmd = PICC_WUPA;
  uint8_t recv[2];
  uint8_t recv_len = 2;
  // WUPA is a 7-bit short frame. ATQA is 16 bits; a single noise byte is not a PICC.
  Status st = this->pcd_transceive_(&cmd, 1, recv, &recv_len, 7);
  if (st != ST_OK)
    return st;
  if (recv_len != 2)
    return ST_TIMEOUT;
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::picc_select_(uint8_t *sak) {
  this->uid_len_ = 0;
  uint8_t cascade_cmds[2] = {PICC_SEL_CL1, PICC_SEL_CL2};
  for (uint8_t level = 0; level < 2; level++) {
    // Per cascade level, not once per poll: ValuesAfterColl left set from the
    // previous level makes the next anticollision frame unreliable.
    this->pcd_clear_bit_(REG_COLL, 0x80);
    uint8_t ac[2] = {cascade_cmds[level], 0x20};
    uint8_t uid4[8];
    uint8_t uid4_len = 5;
    Status st = this->pcd_transceive_(ac, 2, uid4, &uid4_len);
    if (st != ST_OK)
      return st;
    if (uid4_len < 5)
      return ST_ERROR;
    // The anticollision response carries BCC instead of CRC_A, so this is the
    // whole integrity check available at this step.
    uint8_t bcc = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3];
    if (bcc != uid4[4])
      return ST_CRC;

    uint8_t sel[9];
    sel[0] = cascade_cmds[level];
    sel[1] = 0x70;
    memcpy(sel + 2, uid4, 4);
    sel[6] = bcc;
    if (!this->pcd_crc_(sel, 7, sel + 7))
      return ST_CRC;
    uint8_t resp[8];
    uint8_t resp_len = 3;
    st = this->pcd_transceive_(sel, 9, resp, &resp_len);
    if (st != ST_OK)
      return st;
    // SAK is one byte plus CRC_A, and it is the byte that decides Classic vs
    // NTAG. It used to be taken on resp_len >= 1 with the CRC never looked at,
    // which is the root of the "wrong card type" reports: RxCRCEn is off in
    // RxModeReg, so nothing else in this driver was checking it either. A SAK
    // we cannot verify is not a SAK - fail and let the next poll re-read.
    if (resp_len != 3 || !this->check_crc_a_(resp, 3)) {
      ESP_LOGD(TAG, "RFID SELECT level=%u bad SAK frame len=%u", (unsigned) level, (unsigned) resp_len);
      return ST_CRC;
    }
    *sak = resp[0];

    bool cascade = uid4[0] == 0x88;
    if (cascade) {
      if (this->uid_len_ + 3 > sizeof(this->uid_))
        return ST_ERROR;
      memcpy(this->uid_ + this->uid_len_, uid4 + 1, 3);
      this->uid_len_ += 3;
    } else {
      if (this->uid_len_ + 4 > sizeof(this->uid_))
        return ST_ERROR;
      memcpy(this->uid_ + this->uid_len_, uid4, 4);
      this->uid_len_ += 4;
    }
    if (!(*sak & 0x04))
      return ST_OK;
  }
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::picc_hlta_() {
  uint8_t cmd[4] = {PICC_HLTA, 0x00, 0, 0};
  if (!this->pcd_crc_(cmd, 2, cmd + 2))
    return ST_CRC;
  uint8_t recv[1];
  uint8_t recv_len = 0;
  this->pcd_transceive_(cmd, 4, recv, &recv_len);
  return ST_OK;
}

bool GuardianRfid::reselect_() {
  // A failed MFAuthent drops the PICC out of the ACTIVE state. ISO 14443-3
  // wants a fresh WUPA + anticollision + SELECT before the next attempt, and
  // without one every "try the other key" path is talking to a card that is
  // no longer listening.
  this->pcd_stop_crypto1_();
  uint8_t saved[10];
  uint8_t saved_len = this->uid_len_;
  if (saved_len == 0 || saved_len > sizeof(saved))
    return false;
  memcpy(saved, this->uid_, saved_len);

  bool ok = this->picc_request_a_() == ST_OK;
  uint8_t sak = 0;
  if (ok)
    ok = this->picc_select_(&sak) == ST_OK && this->uid_len_ != 0;
  // Whatever we go on to authenticate and rotate must be the same card we
  // started with, not a second one that entered the field mid-sequence.
  if (ok && (this->uid_len_ != saved_len || memcmp(saved, this->uid_, saved_len) != 0)) {
    ESP_LOGD(TAG, "RFID reselect returned a different UID, abandoning");
    ok = false;
  }
  if (!ok) {
    // picc_select_ zeroes uid_len_ on entry and rebuilds as it goes, so a
    // failure part-way leaves a truncated UID behind. Put the caller's UID
    // back: everything downstream keys off it, including what update() latches.
    memcpy(this->uid_, saved, saved_len);
    this->uid_len_ = saved_len;
  }
  return ok;
}

GuardianRfid::Status GuardianRfid::ntag_read_(uint8_t page, uint8_t *out16) {
  uint8_t cmd[4] = {PICC_READ, page, 0, 0};
  if (!this->pcd_crc_(cmd, 2, cmd + 2))
    return ST_CRC;
  uint8_t recv[18];
  uint8_t recv_len = 18;
  Status st = this->pcd_transceive_(cmd, 4, recv, &recv_len);
  if (st != ST_OK)
    return st;
  if (recv_len == 1 && (recv[0] == 0x04 || recv[0] == 0x05))
    return ST_NAK;
  if (recv_len < 16)
    return ST_ERROR;
  // 16 data bytes + CRC_A. Without this check a garbled read reached
  // verify_mac_ and came back as bad_mac - a security verdict against the
  // card's owner for what was actually a bad frame on the coil.
  if (recv_len < 18 || !this->check_crc_a_(recv, 18)) {
    ESP_LOGD(TAG, "RFID READ page=%u bad frame len=%u", (unsigned) page, (unsigned) recv_len);
    return ST_CRC;
  }
  memcpy(out16, recv, 16);
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::ntag_write_(uint8_t page, const uint8_t in4[4]) {
  uint8_t cmd[8];
  cmd[0] = PICC_UL_WRITE;
  cmd[1] = page;
  memcpy(cmd + 2, in4, 4);
  if (!this->pcd_crc_(cmd, 6, cmd + 6))
    return ST_CRC;
  uint8_t recv[4];
  uint8_t recv_len = 4;
  Status st = this->pcd_transceive_(cmd, 8, recv, &recv_len);
  if (st != ST_OK)
    return st;
  // 4-bit ACK 0xA can land in either nibble depending on RxLastBits.
  if (picc_ack_ok(recv, recv_len))
    return ST_OK;
  return ST_NAK;
}

GuardianRfid::Status GuardianRfid::ntag_pwd_auth_(const uint8_t pwd[4], uint8_t pack[2]) {
  uint8_t cmd[8];
  cmd[0] = PICC_PWD_AUTH;
  memcpy(cmd + 1, pwd, 4);
  if (!this->pcd_crc_(cmd, 5, cmd + 5))
    return ST_CRC;
  uint8_t recv[8];
  uint8_t recv_len = 4;
  Status st = this->pcd_transceive_(cmd, 7, recv, &recv_len);
  if (st != ST_OK)
    return st;
  if (recv_len < 2)
    return ST_NAK;
  pack[0] = recv[0];
  pack[1] = recv[1];
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::ntag_get_version_(uint8_t *out8) {
  uint8_t cmd[3] = {PICC_GET_VERSION, 0, 0};
  if (!this->pcd_crc_(cmd, 1, cmd + 1))
    return ST_CRC;
  uint8_t recv[10];
  uint8_t recv_len = 10;
  Status st = this->pcd_transceive_(cmd, 3, recv, &recv_len);
  if (st != ST_OK || recv_len < 8)
    return ST_UNSUPPORTED;
  // out8[6] is the storage size that picks which CFG pages protect_ntag_
  // writes to, so a garbled version response would aim the PWD write at the
  // wrong page. 8 bytes + CRC_A; treat an unverifiable one as no version at
  // all, which falls back to the NTAG213 page addresses.
  if (recv_len < 10 || !this->check_crc_a_(recv, 10))
    return ST_UNSUPPORTED;
  memcpy(out8, recv, 8);
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::mifare_write_block_(uint8_t block, const uint8_t in16[16]) {
  uint8_t cmd[4] = {PICC_MF_WRITE, block, 0, 0};
  if (!this->pcd_crc_(cmd, 2, cmd + 2))
    return ST_CRC;
  uint8_t recv[4];
  uint8_t recv_len = 4;
  Status st = this->pcd_transceive_(cmd, 4, recv, &recv_len);
  if (st != ST_OK)
    return st;
  if (!picc_ack_ok(recv, recv_len))
    return ST_NAK;

  uint8_t data[18];
  memcpy(data, in16, 16);
  if (!this->pcd_crc_(data, 16, data + 16))
    return ST_CRC;
  recv_len = 4;
  st = this->pcd_transceive_(data, 18, recv, &recv_len);
  if (st != ST_OK)
    return st;
  if (!picc_ack_ok(recv, recv_len))
    return ST_NAK;
  return ST_OK;
}

bool GuardianRfid::hmac_sha256_(const uint8_t *data, size_t len, uint8_t out32[32]) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr || mbedtls_md_setup(&ctx, info, 1) != 0) {
    mbedtls_md_free(&ctx);
    return false;
  }
  mbedtls_md_hmac_starts(&ctx, this->master_key_, 32);
  mbedtls_md_hmac_update(&ctx, data, len);
  mbedtls_md_hmac_finish(&ctx, out32);
  mbedtls_md_free(&ctx);
  return true;
}

// Every derivation below is UID-bound, and every one of them can FAIL.
//
// hmac_sha256_ returns false when mbedtls cannot allocate its context, and its
// out32 is then never written. All five call sites used to discard that,
// memcpy'ing uninitialised stack into a password, a Crypto1 key or a MAC. For
// verification that is merely fail-closed - garbage never equals the card's MAC
// - but for the WRITE paths it is fail-corrupt: fill_payload_ would burn a
// garbage MAC onto a card, and write_payload_'s read-back verify would PASS,
// because it compares the card against what we intended to write rather than
// against what we should have written. The card is then reported "enrolled"
// while being permanently unusable, and the only way back is re-enrollment.
// So every derivation returns bool and every caller is required to check it.
//
// The three buffers below are sized to fit exactly, and that is a load-bearing
// invariant with no margin: label + uid_len_ must not exceed them. uid_len_ is
// bounded to 10 by picc_select_, but the bound lives 200 lines away from the
// memcpy that depends on it, so it is asserted here as well. A future change to
// uid_[], to the cascade depth, or to a label length would otherwise overflow
// silently.
// ISO/IEC 14443-3 defines exactly three UID sizes: 4 (single), 7 (double
// cascade) and 10 (triple cascade) bytes. Both bounds are relied on by
// compute_mac_'s domain-separation argument - see the long note there.
static const size_t MIN_UID_LEN = 4;
static const size_t MAX_UID_LEN = 10;

void GuardianRfid::derive_pwd_pack_(uint8_t pwd[4], uint8_t pack[2], bool *ok) {
  *ok = false;
  if (this->uid_len_ == 0 || this->uid_len_ > MAX_UID_LEN)
    return;
  uint8_t buf[4 + MAX_UID_LEN];
  uint8_t out[32];
  memcpy(buf, "pwd", 3);
  memcpy(buf + 3, this->uid_, this->uid_len_);
  if (!this->hmac_sha256_(buf, 3 + this->uid_len_, out))
    return;
  memcpy(pwd, out, 4);

  memcpy(buf, "pack", 4);
  memcpy(buf + 4, this->uid_, this->uid_len_);
  if (!this->hmac_sha256_(buf, 4 + this->uid_len_, out))
    return;
  memcpy(pack, out, 2);
  *ok = true;
}

void GuardianRfid::derive_classic_keys_(uint8_t key_a[6], uint8_t key_b[6], bool *ok) {
  // Same construction as derive_pwd_pack_, different labels: two independent
  // 6-byte Crypto1 keys bound to this card's UID. Both are secret, so the
  // sector stays unreadable whichever key an attacker's reader tries.
  *ok = false;
  if (this->uid_len_ == 0 || this->uid_len_ > MAX_UID_LEN)
    return;
  uint8_t buf[4 + MAX_UID_LEN];
  uint8_t out[32];
  memcpy(buf, "clsA", 4);
  memcpy(buf + 4, this->uid_, this->uid_len_);
  if (!this->hmac_sha256_(buf, 4 + this->uid_len_, out))
    return;
  memcpy(key_a, out, 6);

  memcpy(buf, "clsB", 4);
  memcpy(buf + 4, this->uid_, this->uid_len_);
  if (!this->hmac_sha256_(buf, 4 + this->uid_len_, out))
    return;
  memcpy(key_b, out, 6);
  *ok = true;
}

bool GuardianRfid::compute_mac_(const uint8_t card_id[8], uint32_t counter, uint8_t mac16[16]) {
  // uid_len_ == 0 would drop the UID binding entirely and make one MAC valid on
  // every card. update() already refuses to call handle_selected_ in that state,
  // but "the UID is in the MAC" is the whole security property and it is
  // asserted where it is relied on rather than only where it happens to hold.
  if (this->uid_len_ == 0 || this->uid_len_ > MAX_UID_LEN)
    return false;
  // NO domain-separation label here, deliberately, and this is the one place in
  // this pass where the safer-looking change is the wrong one.
  //
  // This construction is distinguished from the pwd/pack/clsA/clsB ones only by
  // an accident of LENGTH: their inputs are label + uid, at most 4 + 10 = 14
  // bytes, while this one is uid + card_id + counter, at least 1 + 8 + 4 = 13
  // and in practice 4 + 8 + 4 = 16 or more. Prefixing "mac1" would state that
  // separation explicitly instead of relying on it.
  //
  // It would also change the MAC of every card in existence. The MAC is what is
  // STORED ON THE CARD; changing its input makes every enrolled card fail
  // verify_mac_, which is not a lockout that degrades gracefully - it is every
  // key in the house becoming a bad_mac security alarm at the door, at once,
  // with re-enrollment as the only recovery. That is the same cost this pass
  // refuses to pay for key rotation, and it buys nothing: no collision is
  // reachable today, because no two labelled inputs can reach 16 bytes.
  //
  // So the invariant is ENFORCED rather than replaced, and enforcing it means
  // being precise about WHY it holds. The longest labelled input is
  // 4 + MAX_UID_LEN = 14 bytes. The shortest MAC input is
  // MIN_UID_LEN + 8 + 4 = 16 bytes. 16 > 14, so no labelled input can ever
  // equal a MAC input and the two derivations cannot collide.
  //
  // That argument depends entirely on MIN_UID_LEN. ISO/IEC 14443-3 defines
  // exactly three UID sizes - 4, 7 and 10 bytes - so 4 is the real floor, but
  // nothing upstream was asserting it: uid_len_ is accumulated in 3- and 4-byte
  // cascade steps and a truncated read could leave it smaller. At uid_len_ = 1
  // the MAC input is 13 bytes and "clsA" + a 9-byte UID is also 13, and the
  // separation silently stops being true. So the floor is checked here, where
  // the argument is made, and the static_assert is what a future change to any
  // of the three lengths trips at compile time.
  static_assert(MIN_UID_LEN + 8 + 4 > 4 + MAX_UID_LEN,
                "MAC input must stay longer than any labelled derivation input, or "
                "compute_mac_ needs its own domain-separation label - which changes "
                "every enrolled card's MAC and requires re-enrolling the house");
  if (this->uid_len_ < MIN_UID_LEN)
    return false;
  uint8_t buf[MAX_UID_LEN + 8 + 4];
  memcpy(buf, this->uid_, this->uid_len_);
  size_t n = this->uid_len_;
  memcpy(buf + n, card_id, 8);
  n += 8;
  put_be32(buf + n, counter);
  n += 4;
  uint8_t out[32];
  if (!this->hmac_sha256_(buf, n, out))
    return false;
  memcpy(mac16, out, 16);
  return true;
}

bool GuardianRfid::verify_mac_(const uint8_t card_id[8], uint32_t counter, const uint8_t mac16[16]) {
  uint8_t expect[16];
  if (!this->compute_mac_(card_id, counter, expect))
    return false;
  // Constant-time. memcmp is a byte-or-word loop with an early exit, so its
  // timing carries how many leading bytes of a forged MAC were correct. In THIS
  // system that leak is not exploitable - one measurement per 500 ms poll,
  // against RF and delay(10) jitter orders of magnitude larger than the
  // difference - but a MAC compared with memcmp is a defect whatever the
  // surrounding timings happen to be, and the fix costs nothing.
  uint8_t diff = 0;
  for (size_t i = 0; i < 16; i++)
    diff |= (uint8_t) (expect[i] ^ mac16[i]);
  return diff == 0;
}

bool GuardianRfid::fill_payload_(const uint8_t card_id[8], uint32_t counter, uint8_t pages[9][4]) {
  uint8_t mac[16];
  // Computed FIRST. Nothing is written into pages[] unless the MAC is real, so
  // a caller that ignores the return value still cannot ship a half-built
  // payload built around uninitialised stack.
  if (!this->compute_mac_(card_id, counter, mac))
    return false;
  memcpy(pages[0], MAGIC, 4);
  pages[1][0] = PAYLOAD_VERSION;
  pages[1][1] = 0;
  pages[1][2] = 0;
  pages[1][3] = 0;
  memcpy(pages[2], card_id, 4);
  memcpy(pages[3], card_id + 4, 4);
  put_be32(pages[4], counter);
  memcpy(pages[5], mac, 4);
  memcpy(pages[6], mac + 4, 4);
  memcpy(pages[7], mac + 8, 4);
  memcpy(pages[8], mac + 12, 4);
  return true;
}

const char *GuardianRfid::status_name_(Status st) const {
  switch (st) {
    case ST_OK:
      return "ok";
    case ST_TIMEOUT:
      return "timeout";
    case ST_ERROR:
      return "error";
    case ST_NAK:
      return "nak";
    case ST_CRC:
      return "crc";
    case ST_COLLISION:
      return "collision";
    case ST_UNSUPPORTED:
      return "unsupported";
  }
  return "?";
}

bool GuardianRfid::write_payload_(const uint8_t pages[9][4]) {
  if (this->picc_classic_)
    return this->classic_write_payload_(pages);
  // Counter page last. pages[4] is the on-card counter (NTAG page 8); pages[5-8]
  // are the MAC (pages 9-12). Writing the counter first, then lifting, left a
  // new counter with the old MAC: verify_mac_ failed forever and Home Assistant
  // saw bad_mac with an empty card_id — "card not recognised" until re-enroll.
  // MAC-first then counter means a torn write is either still the old consistent
  // payload or has the new MAC against the old counter, both healable. Identity
  // pages (magic / version / card_id) do not change on a rotate and go first.
  static const uint8_t kOrder[9] = {0, 1, 2, 3, 5, 6, 7, 8, 4};
  for (uint8_t n = 0; n < 9; n++) {
    uint8_t i = kOrder[n];
    uint8_t page = (uint8_t) (PAGE_MAGIC + i);
    bool ok = false;
    Status st = ST_ERROR;
    for (int attempt = 0; attempt < 3 && !ok; attempt++) {
      st = this->ntag_write_(page, pages[i]);
      if (st == ST_OK)
        ok = true;
    }
    if (!ok) {
      ESP_LOGI(TAG, "RFID write fail page=%u status=%s source=%s", (unsigned) page, this->status_name_(st),
               this->source_.c_str());
      return false;
    }
  }
  // The pages went down one retry-loop at a time; the read-back gets the same
  // courtesy. Now that a garbled frame is reported as ST_CRC instead of being
  // copied out silently, a single bad read here would otherwise condemn a
  // write that actually succeeded.
  uint8_t check[9][4];
  Status rst = ST_ERROR;
  for (int attempt = 0; attempt < 3; attempt++) {
    rst = this->read_payload_(check);
    if (rst == ST_OK)
      break;
  }
  if (rst != ST_OK) {
    ESP_LOGI(TAG, "RFID write fail read-back status=%s source=%s", this->status_name_(rst), this->source_.c_str());
    return false;
  }
  if (memcmp(pages, check, sizeof(check)) != 0) {
    ESP_LOGI(TAG, "RFID write fail verify source=%s", this->source_.c_str());
    return false;
  }
  return true;
}

GuardianRfid::Status GuardianRfid::read_payload_(uint8_t pages[9][4]) {
  if (this->picc_classic_)
    return this->classic_read_payload_(pages);
  uint8_t block[16];
  // Three 16-byte reads cover pages 4-15.
  Status st = this->ntag_read_(4, block);
  if (st != ST_OK)
    return st;
  memcpy(pages[0], block, 16);
  st = this->ntag_read_(8, block);
  if (st != ST_OK)
    return st;
  memcpy(pages[4], block, 16);
  st = this->ntag_read_(12, block);
  if (st != ST_OK)
    return st;
  memcpy(pages[8], block, 4);
  return ST_OK;
}

GuardianRfid::Status GuardianRfid::classic_read_payload_(uint8_t pages[9][4]) {
  uint8_t blocks[3][16];
  for (uint8_t i = 0; i < 3; i++) {
    uint8_t block = (uint8_t) (CLASSIC_BLOCK0 + i);
    Status st = this->ntag_read_(block, blocks[i]);
    if (st != ST_OK) {
      ESP_LOGD(TAG, "RFID classic read block=%u status=%s", (unsigned) block, this->status_name_(st));
      return st;
    }
  }
  memcpy(pages[0], blocks[0], 16);
  memcpy(pages[4], blocks[1], 16);
  memcpy(pages[8], blocks[2], 4);
  return ST_OK;
}

bool GuardianRfid::classic_write_payload_(const uint8_t pages[9][4]) {
  uint8_t blocks[3][16];
  memcpy(blocks[0], pages[0], 16);
  memcpy(blocks[1], pages[4], 16);
  memcpy(blocks[2], pages[8], 4);
  memset(blocks[2] + 4, 0, 12);
  // Block 4 is identity (unchanged on rotate). Block 6 is the MAC tail. Block 5
  // holds the counter and the first 12 MAC bytes — that is the commit. Same
  // reason as NTAG: a lift after the counter block used to leave a new counter
  // with a mixed MAC that nothing could verify, which is a dead key.
  static const uint8_t kOrder[3] = {0, 2, 1};
  for (uint8_t n = 0; n < 3; n++) {
    uint8_t i = kOrder[n];
    uint8_t block = (uint8_t) (CLASSIC_BLOCK0 + i);
    bool ok = false;
    Status st = ST_ERROR;
    for (int attempt = 0; attempt < 3 && !ok; attempt++) {
      st = this->mifare_write_block_(block, blocks[i]);
      if (st == ST_OK)
        ok = true;
    }
    if (!ok) {
      ESP_LOGI(TAG, "RFID classic write fail block=%u status=%s source=%s", (unsigned) block, this->status_name_(st),
               this->source_.c_str());
      return false;
    }
  }
  uint8_t check[9][4];
  Status rst = ST_ERROR;
  for (int attempt = 0; attempt < 3; attempt++) {
    rst = this->classic_read_payload_(check);
    if (rst == ST_OK)
      break;
  }
  if (rst != ST_OK) {
    ESP_LOGI(TAG, "RFID classic write fail read-back status=%s source=%s", this->status_name_(rst),
             this->source_.c_str());
    return false;
  }
  if (memcmp(pages, check, sizeof(check)) != 0) {
    ESP_LOGI(TAG, "RFID classic write fail verify source=%s", this->source_.c_str());
    return false;
  }
  return true;
}

GuardianRfid::Status GuardianRfid::classic_authenticate_() {
  // Sector 1 only, never sector 0. Diversified Key A first, so an upgraded
  // card authenticates on the first attempt and the public transport key is
  // never put on the air for it. Fall back to the transport key for cards
  // that have not been upgraded yet, and re-select between every attempt.
  uint8_t key_a[6], key_b[6];
  bool derived = false;
  this->derive_classic_keys_(key_a, key_b, &derived);
  // ST_ERROR, not a fall-through to the transport key. Without the diversified
  // key there is nothing to authenticate WITH, and continuing would try the
  // public key as if the card were legacy - turning a transient mbedtls failure
  // into an unnecessary trailer rewrite on a card that was already upgraded.
  if (!derived) {
    ESP_LOGW(TAG, "RFID classic AUTH skipped: key derivation failed source=%s", this->source_.c_str());
    return ST_ERROR;
  }

  Status st = this->pcd_mf_authent_(PICC_MF_AUTH_A, CLASSIC_BLOCK0, key_a);
  if (st == ST_OK) {
    this->classic_legacy_key_ = false;
    ESP_LOGD(TAG, "RFID classic AUTH key=diversified-A block=%u ok", (unsigned) CLASSIC_BLOCK0);
    return ST_OK;
  }
  // The diversified key was rejected, so this card has not been upgraded (or is
  // not ours). Falling back to the published transport key is what adopts an
  // existing card and what makes a factory-blank card enrollable - and it is
  // also the permanent downgrade path, so a household that has finished
  // upgrading can switch it off.
  //
  // Enrollment is exempt on purpose. A factory Classic card authenticates with
  // NOTHING ELSE, so refusing the transport key while enrolling would not
  // harden anything, it would just make Classic enrollment impossible and the
  // failure would read as "this card is broken".
  if (!this->allow_transport_key_ && !this->enrollment_on_()) {
    ESP_LOGI(TAG,
             "RFID classic AUTH refused: card is still on the transport key and "
             "allow_transport_key is off source=%s uid_bytes=%u",
             this->source_.c_str(), (unsigned) this->uid_len_);
    return ST_NAK;
  }
  ESP_LOGD(TAG, "RFID classic AUTH key=diversified-A block=%u status=%s, trying transport key",
           (unsigned) CLASSIC_BLOCK0, this->status_name_(st));

  if (!this->reselect_())
    return ST_TIMEOUT;
  st = this->pcd_mf_authent_(PICC_MF_AUTH_A, CLASSIC_BLOCK0, CLASSIC_TRANSPORT_KEY);
  if (st == ST_OK) {
    this->classic_legacy_key_ = true;
    ESP_LOGD(TAG, "RFID classic AUTH key=transport-A block=%u ok (upgrade pending)",
             (unsigned) CLASSIC_BLOCK0);
    return ST_OK;
  }

  if (!this->reselect_())
    return ST_TIMEOUT;
  st = this->pcd_mf_authent_(PICC_MF_AUTH_B, CLASSIC_BLOCK0, CLASSIC_TRANSPORT_KEY);
  if (st == ST_OK) {
    this->classic_legacy_key_ = true;
    ESP_LOGD(TAG, "RFID classic AUTH key=transport-B block=%u ok (upgrade pending)",
             (unsigned) CLASSIC_BLOCK0);
    return ST_OK;
  }
  ESP_LOGD(TAG, "RFID classic AUTH every key rejected block=%u status=%s", (unsigned) CLASSIC_BLOCK0,
           this->status_name_(st));
  return ST_NAK;
}

bool GuardianRfid::classic_upgrade_trailer_() {
  uint8_t key_a[6], key_b[6];
  bool derived = false;
  this->derive_classic_keys_(key_a, key_b, &derived);
  // A failed derivation here would write SIX UNINITIALISED STACK BYTES into the
  // sector trailer as Key A. The sector would then authenticate with neither
  // the transport key nor any key this reader can recompute, and the card is
  // bricked - permanently, with no un-protect path in this component. Refusing
  // to write is a deferred upgrade; writing is an unrecoverable card.
  if (!derived) {
    ESP_LOGW(TAG, "RFID classic trailer upgrade skipped: key derivation failed source=%s",
             this->source_.c_str());
    return false;
  }

  uint8_t trailer[16];
  memcpy(trailer, key_a, 6);
  memcpy(trailer + 6, CLASSIC_ACCESS_BYTES, 4);
  memcpy(trailer + 10, key_b, 6);

  Status st = this->mifare_write_block_(CLASSIC_TRAILER, trailer);
  if (st != ST_OK) {
    ESP_LOGI(TAG, "RFID classic trailer write status=%s source=%s", this->status_name_(st),
             this->source_.c_str());
    return false;
  }
  // Prove the new key actually works before claiming the card is upgraded.
  // The trailer is write-only, so a read-back verify is not available here.
  if (!this->reselect_())
    return false;
  if (this->pcd_mf_authent_(PICC_MF_AUTH_A, CLASSIC_BLOCK0, key_a) != ST_OK) {
    ESP_LOGI(TAG, "RFID classic trailer written but new key did not authenticate source=%s",
             this->source_.c_str());
    return false;
  }
  this->classic_legacy_key_ = false;
  return true;
}

void GuardianRfid::maybe_upgrade_classic_() {
  if (!this->picc_classic_ || !this->classic_legacy_key_)
    return;
  // Strictly best effort. A card that fails this is still a completely working
  // card on its old key and will be offered the upgrade again on the next tap;
  // a trailer failure must never turn a valid scan into a denial.
  //
  // This now runs BEFORE the payload write rather than after it, so that a
  // rotated counter, its fresh MAC, and a newly minted card_id are never put on
  // the air inside a Crypto1 session keyed with the published transport key.
  // That reordering moves the risk: the caller writes the payload immediately
  // after this returns, and a FAILED upgrade leaves the session in whatever
  // state the failure produced - classic_upgrade_trailer_ does a reselect_()
  // and re-authenticates on its success path, and does neither if it gave up
  // partway.
  //
  // Unrepaired, that turns "the upgrade was deferred" into "the payload write
  // also failed", which is a functional regression against the old ordering for
  // exactly the marginal-RF cards most likely to defer. So the session is put
  // back before returning. classic_authenticate_ tries the diversified key
  // first and falls back to the transport key, which is the right order either
  // way: if the trailer DID commit before the failure, the new key is now the
  // live one.
  if (this->classic_upgrade_trailer_()) {
    ESP_LOGI(TAG, "RFID classic sector key upgraded to per-card keys source=%s", this->source_.c_str());
    return;
  }
  ESP_LOGI(TAG, "RFID classic sector key upgrade deferred source=%s", this->source_.c_str());
  if (this->classic_authenticate_() != ST_OK) {
    ESP_LOGW(TAG, "RFID classic session lost after a deferred upgrade source=%s", this->source_.c_str());
  }
}

uint8_t GuardianRfid::cfg0_page_() const {
  switch (this->storage_size_) {
    case 0x11:
      return 0x83;  // NTAG215
    case 0x13:
      return 0xE3;  // NTAG216
    default:
      return 0x29;  // NTAG213
  }
}

bool GuardianRfid::protect_ntag_() {
  uint8_t pwd[4], pack[2];
  bool derived = false;
  this->derive_pwd_pack_(pwd, pack, &derived);
  // Writing an uninitialised-stack password would lock the card with a value
  // this reader can never recompute - unrecoverable, since a protected NTAG
  // refuses both the read and the rewrite and there is no un-protect path here.
  if (!derived) {
    ESP_LOGW(TAG, "RFID NTAG protect failed: password derivation failed source=%s",
             this->source_.c_str());
    return false;
  }
  uint8_t cfg0 = this->cfg0_page_();
  uint8_t pack_page[4] = {pack[0], pack[1], 0, 0};
  if (this->ntag_write_((uint8_t) (cfg0 + 2), pwd) != ST_OK)
    return false;
  if (this->ntag_write_((uint8_t) (cfg0 + 3), pack_page) != ST_OK)
    return false;
  uint8_t cfg1[4] = {0x80, 0x00, 0x00, 0x00};  // PROT=1, AUTHLIM=0
  if (this->ntag_write_((uint8_t) (cfg0 + 1), cfg1) != ST_OK)
    return false;
  uint8_t cfg0b[4] = {0x00, 0x00, 0x00, PAGE_MAGIC};  // AUTH0 = page 4
  return this->ntag_write_(cfg0, cfg0b) == ST_OK;
}

bool GuardianRfid::authenticate_ntag_() {
  uint8_t pwd[4], pack[2], got[2];
  bool derived = false;
  this->derive_pwd_pack_(pwd, pack, &derived);
  if (!derived) {
    ESP_LOGW(TAG, "RFID NTAG auth failed: password derivation failed source=%s",
             this->source_.c_str());
    return false;
  }
  if (this->ntag_pwd_auth_(pwd, got) != ST_OK)
    return false;
  // Constant-time, for the same reason as verify_mac_. PACK is only 16 bits and
  // a failure here yields no access, so the leak is worth little - but it costs
  // one line to not have it.
  return (uint8_t) ((got[0] ^ pack[0]) | (got[1] ^ pack[1])) == 0;
}

bool GuardianRfid::enrollment_on_() const {
  return this->enrollment_ != nullptr && this->enrollment_->has_state() && this->enrollment_->state;
}

bool GuardianRfid::transient_(const char *what, Status st) {
  if (st != ST_TIMEOUT && st != ST_CRC && st != ST_COLLISION && st != ST_ERROR)
    return false;
  if (this->transient_retries_ >= MAX_TRANSIENT_RETRIES)
    return false;  // Budget spent: let the caller report a verdict rather than spin.
  this->link_error_ = true;
  ESP_LOGD(TAG, "RFID %s transient status=%s attempt=%u source=%s", what, this->status_name_(st),
           (unsigned) (this->transient_retries_ + 1), this->source_.c_str());
  return true;
}

bool GuardianRfid::same_uid_(const uint8_t *uid, uint8_t len) const {
  return this->have_current_ && this->current_uid_len_ == len && memcmp(this->current_uid_, uid, len) == 0;
}

void GuardianRfid::fire_scan_(const char *result, bool rotated) {
  this->result_ = result;
  this->rotated_ = rotated;
  this->latch_published_uid_();
  for (auto &cb : this->scan_callbacks_)
    cb();
}

void GuardianRfid::defer_write_fail_() {
  this->pending_retry_ = true;
  ESP_LOGI(TAG, "RFID write fail, retrying silently source=%s", this->source_.c_str());
}

void GuardianRfid::latch_published_uid_() {
  this->scan_published_ = true;
  if (this->uid_len_ > 0 && this->uid_len_ <= sizeof(this->published_uid_)) {
    memcpy(this->published_uid_, this->uid_, this->uid_len_);
    this->published_uid_len_ = this->uid_len_;
  } else if (this->current_uid_len_ > 0 && this->current_uid_len_ <= sizeof(this->published_uid_)) {
    memcpy(this->published_uid_, this->current_uid_, this->current_uid_len_);
    this->published_uid_len_ = this->current_uid_len_;
  }
}

void GuardianRfid::clear_published_uid_() {
  this->scan_published_ = false;
  this->published_uid_len_ = 0;
}

bool GuardianRfid::same_published_uid_(const uint8_t *uid, uint8_t len) const {
  return this->scan_published_ && this->published_uid_len_ == len && len > 0 &&
         memcmp(this->published_uid_, uid, len) == 0;
}

bool GuardianRfid::is_mifare_classic_sak_(uint8_t sak) const {
  return sak == 0x08 || sak == 0x18 || sak == 0x09 || sak == 0x19;
}

uint32_t GuardianRfid::next_counter_(uint32_t counter) {
  uint32_t next = counter + 1;
  if (next == 0)
    next = 1;
  return next;
}

void GuardianRfid::attempt_rotate_write_(const uint8_t card_id[8], uint32_t next, bool fire_ok_on_fill_fail) {
  uint8_t next_pages[9][4];
  if (!this->fill_payload_(card_id, next, next_pages)) {
    // The card is genuine if we just verified, so this is not a security
    // verdict and must not become one. Report the scan on the counter we
    // READ and rotate nothing: write_payload_'s read-back compares the card
    // against next_pages, so a garbage MAC here would VERIFY and the card
    // would be left permanently unreadable by its own reader.
    ESP_LOGW(TAG, "RFID rotate skipped: MAC derivation failed source=%s", this->source_.c_str());
    if (fire_ok_on_fill_fail) {
      this->fire_scan_("ok", false);
    } else {
      this->defer_write_fail_();
    }
    return;
  }
  memcpy(this->retry_card_id_, card_id, 8);
  this->retry_next_counter_ = next;
  this->have_retry_target_ = true;
  for (auto &cb : this->write_begin_callbacks_)
    cb();
  // Upgrade the Classic sector BEFORE writing the new payload, not after.
  //
  // Crypto1's keystream is fully determined by the key and the nonces, and
  // the transport key is published in this file. So every byte sent while
  // the session is open under FFFFFFFFFFFF is readable by a passive
  // eavesdropper. Writing the rotated counter and its fresh MAC first put
  // the new credential on the air in the clear, and then secured the sector
  // afterwards - protecting the card from that point on while handing away
  // the thing it was protecting.
  //
  // Upgrading first costs nothing: classic_upgrade_trailer_ re-authenticates
  // with the new Key A before returning true, so the session that follows is
  // already keyed with the diversified key and write_payload_ works
  // unchanged. It is still strictly best-effort - a failed upgrade logs
  // "deferred" and leaves the card usable - so this cannot turn a valid scan
  // into a denial.
  //
  // The trailer write itself remains the one exchange that is unavoidably
  // sent under the public key. That is inherent to adopting a factory card
  // and is why NTAG21x is the recommended medium.
  this->maybe_upgrade_classic_();
  // Session is already open: PWD_AUTH ran only if the read NAKed. Do not
  // PWD_AUTH factory blanks before a rotate — some clones drop SELECT.
  if (this->write_payload_(next_pages)) {
    this->card_id_hex_ = to_hex(card_id, 8);
    this->counter_ = next;
    this->pending_retry_ = false;
    this->have_retry_target_ = false;
    this->fire_scan_("ok", true);
  } else {
    this->defer_write_fail_();
  }
}

bool GuardianRfid::heal_torn_payload_(const uint8_t card_id[8], uint32_t counter, const uint8_t mac[16]) {
  // A dump clone is internally consistent (MAC matches its stored counter), so
  // matching counter-1 or counter+1 is a torn write, not a stale dump. Do not
  // rewrite a MAC for an arbitrary on-card counter — that would let a writer
  // who can already mutate bytes mint a valid credential at a chosen value.
  uint32_t recovered = 0;
  const char *how = nullptr;
  if (counter > 1 && this->verify_mac_(card_id, counter - 1, mac)) {
    // Counter page committed, MAC pages did not. Complete the payload for the
    // counter already on the card — that is the rotate we were in the middle of.
    recovered = counter;
    how = "counter-1";
  } else {
    uint32_t ahead = next_counter_(counter);
    if (this->verify_mac_(card_id, ahead, mac)) {
      // MAC pages committed, counter page did not (the new write order). Finish
      // by writing the matching counter.
      recovered = ahead;
      how = "counter+1";
    }
  }
  if (how != nullptr) {
    ESP_LOGI(TAG, "RFID torn-write recovery via %s source=%s counter=%u -> %u", how, this->source_.c_str(),
             (unsigned) counter, (unsigned) recovered);
    this->attempt_rotate_write_(card_id, recovered, false);
    return true;
  }
  if (this->have_retry_target_ && memcmp(card_id, this->retry_card_id_, 8) == 0) {
    ESP_LOGI(TAG, "RFID retrying stashed rotate source=%s counter=%u", this->source_.c_str(),
             (unsigned) this->retry_next_counter_);
    this->attempt_rotate_write_(card_id, this->retry_next_counter_, false);
    return true;
  }
  return false;
}

void GuardianRfid::consume_payload_(uint8_t pages[9][4], bool have, bool ntag_pwd_ok) {
  // ntag_pwd_ok used to be `(void)`-discarded on this line, which meant the
  // NTAG password was never an AUTHENTICATION factor - only a confidentiality
  // one. A tag whose payload read with no password at all was accepted exactly
  // like one behind PROT=1, so the attack was not "break the password", it was
  // "do not set one": copy the 36 bytes onto an unprotected UID-writable NTAG,
  // the plain read succeeds, no NAK, PWD_AUTH is never attempted, the MAC
  // verifies against the spoofed UID, and the reader reports ok.
  //
  // It is now recorded and published. This does not by itself make the password
  // a factor - refusing an unprotected tag outright would lock out every card
  // enrolled before this pass, including any card the have_version_ bug left
  // unprotected, which is the population that most needs to be let in and
  // re-enrolled rather than turned away at the door. So the reader reports what
  // it saw and Home Assistant decides. `unprotected` is surfaced on the scan
  // so a household can see which of their keys are readable, and the honest
  // statement in INSTALL.md is that an unprotected NTAG is clonable.
  this->ntag_protected_ = ntag_pwd_ok;
  bool gdn1 = have && memcmp(pages[0], MAGIC, 4) == 0 && pages[1][0] == PAYLOAD_VERSION;

  if (gdn1) {
    uint8_t card_id[8];
    memcpy(card_id, pages[2], 8);
    uint32_t counter = be32(pages[4]);
    uint8_t mac[16];
    memcpy(mac, pages[5], 16);
    // Always publish the on-card id, even when the MAC fails. Clearing it in
    // handle_selected_ and then firing bad_mac left Home Assistant with nothing
    // to match, so a registered key painted "Card not recognised" and the only
    // recovery anyone found was re-enroll — which mints a new card_id and
    // masks the desync.
    this->card_id_hex_ = to_hex(card_id, 8);
    this->counter_ = counter;
    if (this->verify_mac_(card_id, counter, mac)) {
      if (this->enrollment_on_()) {
        // Already a Guardian card. HA binds or reports ENROLL_DUP. Do not rotate
        // during enrollment: a rotate that then fails the HA bind would desync
        // a card that was never stored.
        this->fire_scan_("ok", false);
        return;
      }

      if (this->have_retry_target_ && memcmp(card_id, this->retry_card_id_, 8) == 0 &&
          counter == this->retry_next_counter_) {
        // Write succeeded on the card, read-back did not, so the last poll
        // deferred. The payload is already at `next`. Rotating again would
        // skip a counter Home Assistant never saw.
        ESP_LOGI(TAG, "RFID rotate already on card, not rotating again source=%s counter=%u",
                 this->source_.c_str(), (unsigned) counter);
        this->pending_retry_ = false;
        this->have_retry_target_ = false;
        this->fire_scan_("ok", true);
        return;
      }

      this->attempt_rotate_write_(card_id, next_counter_(counter), true);
      return;
    }

    if (!this->enrollment_on_()) {
      if (this->heal_torn_payload_(card_id, counter, mac))
        return;
      this->fire_scan_("bad_mac");
      return;
    }
    // Partial enroll left GDN1 magic without a valid HMAC. Rewrite as a blank
    // rather than HOLDing forever on a tag that still accepts writes.
    ESP_LOGI(TAG, "RFID enroll overwriting GDN1 with bad MAC source=%s", this->source_.c_str());
  }

  if (!this->enrollment_on_()) {
    this->fire_scan_(have ? "bad_mac" : "unsupported_tag");
    return;
  }

  // Enrollment: blank, foreign, or corrupt GDN1. Same write on both media.
  uint8_t card_id[8];
  esp_fill_random(card_id, 8);
  uint8_t new_pages[9][4];
  if (!this->fill_payload_(card_id, 1, new_pages)) {
    ESP_LOGW(TAG, "RFID enroll aborted: MAC derivation failed source=%s", this->source_.c_str());
    this->defer_write_fail_();
    return;
  }
  for (auto &cb : this->write_begin_callbacks_)
    cb();
  // Upgrade first here too, for the same reason as the rotate path above: a
  // brand-new card_id and its MAC are exactly what must not be broadcast under
  // the published transport key. This is the first and only time this card_id
  // ever crosses the air.
  this->maybe_upgrade_classic_();
  if (!this->write_payload_(new_pages)) {
    this->defer_write_fail_();
    return;
  }
  // An NTAG is enrolled ONLY behind a confirmed password. There is no third
  // outcome here: either protect_ntag_() succeeded, or this is not an
  // enrollment.
  //
  // The previous shape of this line was
  //
  //     if (!picc_classic_ && have_version_ && !protect_ntag_()) { abort }
  //
  // with the comment below it explaining that the return value is now checked,
  // "so a card whose PWD/AUTH0 writes failed was still reported enrolled ...
  // with its payload left world-readable" could not happen any more. It could.
  // `have_version_` sits in the middle of the conjunction, so when GET_VERSION
  // had failed the whole condition was false, protect_ntag_() was NEVER CALLED,
  // and control fell straight through to fire_scan_("enrolled", true). The card
  // was bound to a slot with its payload readable by any phone, "enrolled" was
  // indistinguishable from a protected enrollment, and nothing was logged.
  //
  // That is the forty-second pass's failure a third time - a comment asserting
  // a guard holds, written above code where it does not - and it is why the
  // condition is now split into separate statements. A guard that can be
  // skipped by an unrelated clause in the same expression is not a guard, and
  // three of these have now shipped.
  //
  // have_version_ is not incidental either. cfg0_page_() needs it to know where
  // the config pages live, and it is false after ONE bad CRC on GET_VERSION
  // (ntag_get_version_ returns ST_UNSUPPORTED for a short frame or a failed
  // CRC), with no retry - while the write paths either side of it retry three
  // times. So the common case for reaching here unprotected was a single
  // garbled frame, not an exotic card.
  //
  // Failing is safe: the card holds a valid but unbound GDN1, and re-running
  // enrollment re-binds the same card_id.
  if (!this->picc_classic_) {
    if (!this->have_version_) {
      ESP_LOGW(TAG,
               "RFID enroll aborted: GET_VERSION failed, cannot locate the config pages to "
               "password-protect this tag. Re-present it. source=%s",
               this->source_.c_str());
      this->defer_write_fail_();
      return;
    }
    if (!this->protect_ntag_()) {
      ESP_LOGW(TAG, "RFID enroll aborted: NTAG password protection failed source=%s",
               this->source_.c_str());
      this->defer_write_fail_();
      return;
    }
    this->ntag_protected_ = true;
  }
  // The Classic upgrade already ran, before write_payload_ above, so that the
  // new card_id never crossed the air under the public transport key. It is
  // idempotent (it returns immediately unless classic_legacy_key_ is still
  // set), but calling it a second time here would only ever re-run on a card
  // whose upgrade had just failed - which is the "deferred" case that is meant
  // to be left alone until the next scan.
  this->ntag_protected_ = this->ntag_protected_ || !this->classic_legacy_key_;
  this->card_id_hex_ = to_hex(card_id, 8);
  this->counter_ = 1;
  this->pending_retry_ = false;
  this->have_retry_target_ = false;
  this->fire_scan_("enrolled", true);
}

void GuardianRfid::handle_selected_(uint8_t sak) {
  this->card_id_hex_.clear();
  this->counter_ = 0;
  this->rotated_ = false;
  this->picc_classic_ = false;
  this->have_version_ = false;
  this->classic_legacy_key_ = false;
  this->link_error_ = false;
  // Cleared per scan. A stale `true` from the previous card would report an
  // unprotected tag as protected, which is the one direction that matters.
  this->ntag_protected_ = false;

  if (!this->have_key_) {
    this->fire_scan_("unsupported_tag");
    return;
  }

  this->picc_classic_ = this->is_mifare_classic_sak_(sak);
  ESP_LOGD(TAG, "RFID SELECT sak=0x%02X branch=%s uid_bytes=%u", sak, this->picc_classic_ ? "classic" : "ntag",
           (unsigned) this->uid_len_);

  if (this->picc_classic_) {
    // Same HMAC+counter credential as NTAG; the sector is keyed with per-card
    // diversified keys (see classic_authenticate_ / classic_upgrade_trailer_).
    Status ast = this->classic_authenticate_();
    if (ast != ST_OK) {
      // ST_TIMEOUT here is "could not re-select between key attempts", i.e. a
      // link problem, not a verdict about the card. Retry it silently.
      if (ast != ST_NAK && this->transient_("classic auth", ast))
        return;
      ESP_LOGI(TAG, "RFID classic AUTH fail source=%s uid_bytes=%u", this->source_.c_str(),
               (unsigned) this->uid_len_);
      if (this->enrollment_on_()) {
        this->defer_write_fail_();
      } else {
        this->fire_scan_("unsupported_tag");
      }
      return;
    }
    uint8_t pages[9][4] = {};
    Status rst = this->read_payload_(pages);
    if (rst != ST_OK && rst != ST_NAK && this->transient_("classic read", rst))
      return;
    // Not a hardcoded `true`, which is what this used to pass. For a Classic
    // card "protected" means the sector opened with the DIVERSIFIED key, not
    // with the published transport key - a card still on FFFFFFFFFFFF is
    // readable by any reader on earth, which is the opposite of protected.
    this->consume_payload_(pages, rst == ST_OK, !this->classic_legacy_key_);
    return;
  }

  // GET_VERSION, retried. This one answer decides where the config pages live,
  // and therefore whether the tag can be password-protected at all - so a
  // single garbled frame used to be the difference between an enrollment and a
  // silently unprotected card. Every other write path here already retries
  // three times; this read, which gates all of them, retried zero times.
  uint8_t ver[8] = {0};
  this->have_version_ = false;
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && !this->reselect_())
      break;
    if (this->ntag_get_version_(ver) == ST_OK) {
      this->have_version_ = true;
      break;
    }
  }
  if (this->have_version_) {
    this->storage_size_ = ver[6];
  } else {
    this->storage_size_ = 0x0F;
    ESP_LOGD(TAG, "RFID GET_VERSION failed after 3 attempts source=%s", this->source_.c_str());
  }

  uint8_t pages[9][4] = {};
  Status rst = this->read_payload_(pages);
  bool authed = false;
  // Factory blanks read without PWD. PWD_AUTH first poisons some clones so the
  // following write never succeeds. Only AUTH after a NAK (AUTH0 already set).
  if (rst == ST_NAK) {
    authed = this->authenticate_ntag_();
    if (authed) {
      rst = this->read_payload_(pages);
    } else {
      ESP_LOGI(TAG, "RFID PWD_AUTH fail source=%s uid_bytes=%u", this->source_.c_str(),
               (unsigned) this->uid_len_);
    }
  }
  // A garbled read must not be scored as bad_mac or blanked over during
  // enrollment. Re-read it while the tag is still on the coil.
  if (rst != ST_OK && rst != ST_NAK && this->transient_("ntag read", rst))
    return;
  this->consume_payload_(pages, rst == ST_OK, authed);
}

void GuardianRfid::update() {
  if (this->is_failed())
    return;

  // miguelbalboa PICC_IsNewCardPresent: a previous higher baud would persist.
  this->pcd_write_(REG_TX_MODE, 0x00);
  this->pcd_write_(REG_RX_MODE, 0x08);  // keep RxNoErr; 0x00 would undo pcd_init_()
  this->pcd_write_(REG_MOD_WIDTH, 0x26);

  this->pcd_antenna_on_();
  // ISO 14443: unmodulated field >= 10 ms after PICC power-up before WUPA.
  // Stock rc522 hid this: it started REQA and returned to loop() (IMU 20 ms)
  // before reading IRQ. This driver asked in the same call 1 ms after field-on;
  // NTAG213 never answered, so there was no INFO scan line and no HA event.
  // Bumped past the 5 ms ISO floor: some NTAG213 clones need more headroom.
  delay(10);
  Status st = this->picc_request_a_();
  // DEBUG on purpose: idle polls (no card) stay quiet at INFO. A miss while a
  // UID is held is logged below so a double-scan is visible.
  ESP_LOGD(TAG, "RFID WUPA source=%s status=%d", this->source_.c_str(), (int) st);
  if (st != ST_OK) {
    this->pcd_stop_crypto1_();
    this->pcd_antenna_off_();
    this->select_fails_ = 0;
    this->transient_retries_ = 0;
    if (this->have_current_ || this->scan_published_ || this->pending_retry_) {
      this->presence_misses_++;
      const bool dropping_current = this->have_current_ && this->presence_misses_ >= PRESENCE_DROP_MISSES;
      const bool dropping_published = this->presence_misses_ >= PUBLISHED_DROP_MISSES;
      ESP_LOGI(TAG, "RFID presence miss source=%s streak=%u uid_bytes=%u %s", this->source_.c_str(),
               (unsigned) this->presence_misses_, (unsigned) this->current_uid_len_,
               dropping_current ? "(removed)" : "(not removed)");
      if (dropping_current) {
        // Terminal write_fail only when this presentation never published a
        // scan. Silent in-coil retries must not spam HA, but lifting the tag
        // while the write is still failing is a real outcome.
        if (this->pending_retry_ && !this->scan_published_)
          this->fire_scan_("write_fail", false);
        this->have_current_ = false;
        this->pending_retry_ = false;
        this->current_uid_len_ = 0;
        for (auto &cb : this->removed_callbacks_)
          cb();
      }
      if (dropping_published) {
        this->clear_published_uid_();
        this->presence_misses_ = 0;
      }
    }
    return;
  }

  this->presence_misses_ = 0;

  uint8_t sak = 0;
  st = this->picc_select_(&sak);
  if (st != ST_OK || this->uid_len_ == 0) {
    if (this->select_fails_ < 0xFF)
      this->select_fails_++;
    ESP_LOGW(TAG, "RFID PICC present but select failed source=%s status=%s uid_bytes=%u fails=%u",
             this->source_.c_str(), this->status_name_(st), (unsigned) this->uid_len_,
             (unsigned) this->select_fails_);
    // A tag that answers WUPA but never yields a CRC-clean SELECT is one this
    // driver cannot identify. Say so once, then stay quiet until it leaves the
    // field, rather than retrying forever with nothing on the display.
    if (this->select_fails_ == SELECT_FAIL_REPORT_AT && !this->have_current_)
      this->fire_scan_("unsupported_tag");
    this->pcd_stop_crypto1_();
    this->pcd_antenna_off_();
    return;
  }
  this->select_fails_ = 0;

  bool skip = (this->same_uid_(this->uid_, this->uid_len_) || this->same_published_uid_(this->uid_, this->uid_len_)) &&
              !this->pending_retry_;
  if (skip) {
    ESP_LOGI(TAG, "RFID skip same UID source=%s uid_bytes=%u counter=%u skipped=true published=%s",
             this->source_.c_str(), (unsigned) this->uid_len_, (unsigned) this->counter_,
             this->scan_published_ ? "true" : "false");
  } else {
    this->handle_selected_(sak);
    if (this->link_error_) {
      // A garbled frame, not a verdict: handle_selected_ reported nothing.
      // Deliberately do NOT latch this UID, so the next poll re-reads the same
      // tag while it is still on the coil.
      //
      // This is the other half of the "scanning it one way says wrong card,
      // flipping it works" report. A single bad frame used to fire
      // unsupported_tag AND latch the UID, and because pending_retry_ is only
      // set on write failures the skip test then suppressed every retry. The
      // verdict stuck until the tag was physically lifted off the antenna -
      // which is exactly what flipping it does.
      // No HLTA: the card's state is already uncertain and the next poll opens
      // with WUPA, which wakes it from IDLE or HALT either way. Skipping it
      // saves a 40 ms transceive timeout on every retry.
      this->transient_retries_++;
      this->pcd_stop_crypto1_();
      this->pcd_antenna_off_();
      return;
    }
    this->transient_retries_ = 0;
    memcpy(this->current_uid_, this->uid_, this->uid_len_);
    this->current_uid_len_ = this->uid_len_;
    this->have_current_ = true;
  }

  this->picc_hlta_();
  this->pcd_stop_crypto1_();
  this->pcd_antenna_off_();
}

}  // namespace guardian_rfid
}  // namespace esphome
