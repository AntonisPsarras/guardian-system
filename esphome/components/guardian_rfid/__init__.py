# Local ESPHome component: MFRC522 + NTAG21x / MIFARE Classic authenticator.
#
# Stock rc522_i2c cannot host this. It turns the antenna off before on_tag
# fires, so a YAML lambda never gets a selected card to read or write. This
# component owns the reader, does HMAC verify / rotate / enroll while the
# PICC is still ACTIVE, then publishes the scan fields for homeassistant.event.

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.components import binary_sensor, i2c
from esphome.const import CONF_ID, CONF_TRIGGER_ID

DEPENDENCIES = ["i2c"]
CODEOWNERS = ["@guardian"]

CONF_SOURCE = "source"
CONF_MASTER_KEY = "master_key"
CONF_ENROLLMENT = "enrollment"
CONF_ALLOW_TRANSPORT_KEY = "allow_transport_key"
CONF_ON_SCAN = "on_scan"
CONF_ON_WRITE_BEGIN = "on_write_begin"
CONF_ON_TAG_REMOVED = "on_tag_removed"

guardian_rfid_ns = cg.esphome_ns.namespace("guardian_rfid")
GuardianRfid = guardian_rfid_ns.class_("GuardianRfid", cg.PollingComponent, i2c.I2CDevice)
GuardianScanTrigger = guardian_rfid_ns.class_(
    "GuardianScanTrigger", automation.Trigger.template()
)
GuardianWriteBeginTrigger = guardian_rfid_ns.class_(
    "GuardianWriteBeginTrigger", automation.Trigger.template()
)
GuardianTagRemovedTrigger = guardian_rfid_ns.class_(
    "GuardianTagRemovedTrigger", automation.Trigger.template()
)


HOWTO_MASTER_KEY = (
    "Run tools/guardian-gen-secrets.py to generate esphome/secrets.yaml, or "
    'generate this one key with `python -c "import secrets; '
    'print(secrets.token_hex(32))"`.'
)


def validate_master_key(value):
    value = cv.string(value).strip().lower()
    if len(value) != 64:
        raise cv.Invalid(
            "master_key must be 64 hex characters (32 bytes). " + HOWTO_MASTER_KEY
        )
    try:
        raw = bytes.fromhex(value)
    except ValueError as err:
        raise cv.Invalid("master_key must be hexadecimal. " + HOWTO_MASTER_KEY) from err
    # A degenerate key passes every check above: 64 zeros are 64 valid hex
    # characters, and secrets.yaml.example shipped exactly that for a long time.
    # A build succeeding on it is the worst outcome available here - every card
    # credential derives from this value (the NTAG21x password, and the MIFARE
    # Classic sector keys that replace the factory FFFFFFFFFFFF on first use), so
    # the whole card scheme would be keyed on a value published in this repo.
    # "Missing key" was always a build failure; this makes "key nobody chose" one
    # too, which is the case that actually happens.
    if len(set(raw)) == 1:
        raise cv.Invalid(
            "master_key is a single repeated byte (%s...), which means it was "
            "copied from the template rather than generated. Every card "
            "credential derives from this key. %s" % (value[:8], HOWTO_MASTER_KEY)
        )
    return value


CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(GuardianRfid),
            cv.Required(CONF_SOURCE): cv.one_of("doorbell", "interior_portal"),
            cv.Required(CONF_MASTER_KEY): validate_master_key,
            cv.Optional(CONF_ENROLLMENT): cv.use_id(binary_sensor.BinarySensor),
            # MIFARE Classic ships keyed with the published transport key
            # FFFFFFFFFFFF. This reader authenticates with it, reads the payload,
            # and upgrades the sector to per-card diversified keys on the spot -
            # which is what lets existing cards be adopted without
            # re-enrollment, and is the ONLY way a factory-blank Classic card
            # can be enrolled at all.
            #
            # It is also a permanent downgrade path: a card whose upgrade never
            # happened, or soft-failed, stays readable by any reader on earth,
            # and the reader accepts it exactly like an upgraded one.
            #
            # DEFAULT IS TRUE, deliberately, and this is a hardening knob rather
            # than a fix. Defaulting it to false was the plan for this pass and
            # it is wrong: with no transport-key auth a factory Classic card can
            # never be enrolled, and every card in a house that has not yet been
            # re-scanned stops working at once - locking people out of their own
            # door to close a hole that a re-scan closes without hurting anyone.
            #
            # Set it to false once every Classic card in the house has been
            # scanned at a Guardian reader (each scan upgrades one card, and the
            # reader now reports `protected: false` for any that have not been).
            # After that, false means a cloned or factory card is refused
            # outright instead of being read. NTAG21x is unaffected and remains
            # the recommended medium: Crypto1 is broken, so an upgraded Classic
            # card is harder to clone, not safe from it.
            cv.Optional(CONF_ALLOW_TRANSPORT_KEY, default=True): cv.boolean,
            cv.Optional(CONF_ON_SCAN): automation.validate_automation(
                {
                    cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(GuardianScanTrigger),
                }
            ),
            cv.Optional(CONF_ON_WRITE_BEGIN): automation.validate_automation(
                {
                    cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(
                        GuardianWriteBeginTrigger
                    ),
                }
            ),
            cv.Optional(CONF_ON_TAG_REMOVED): automation.validate_automation(
                {
                    cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(
                        GuardianTagRemovedTrigger
                    ),
                }
            ),
        }
    )
    .extend(cv.polling_component_schema("500ms"))
    .extend(i2c.i2c_device_schema(0x28))
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await i2c.register_i2c_device(var, config)
    cg.add(var.set_source(config[CONF_SOURCE]))
    cg.add(var.set_master_key_hex(config[CONF_MASTER_KEY]))
    cg.add(var.set_allow_transport_key(config[CONF_ALLOW_TRANSPORT_KEY]))
    if CONF_ENROLLMENT in config:
        sens = await cg.get_variable(config[CONF_ENROLLMENT])
        cg.add(var.set_enrollment_sensor(sens))
    for conf in config.get(CONF_ON_SCAN, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)
    for conf in config.get(CONF_ON_WRITE_BEGIN, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)
    for conf in config.get(CONF_ON_TAG_REMOVED, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [], conf)
