#!/usr/bin/env python3
"""
Generate an iOS/macOS Shortcut (.shortcut) file for Apple Health → Locigram ingestion.
48 data points per day (30-min intervals), POSTed as a batch to /api/webhook/health.

Usage:
  python3 generate-health-shortcut.py \
    --url "https://mcp.locigram.ai/api/webhook/health" \
    --token "YOUR_PALACE_TOKEN" \
    --name "Andrew Le" \
    --output health-to-locigram.shortcut
"""

import plistlib
import argparse
import uuid
import sys

def make_uuid():
    return str(uuid.uuid4()).upper()

def text_action(text, var_name=None):
    """Create a Text action, optionally setting a variable."""
    action = {
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': {
                'Value': {
                    'attachmentsByRange': {},
                    'string': text,
                },
                'WFSerializationType': 'WFTextTokenString',
            },
        },
    }
    if var_name:
        return [action, set_variable(var_name)]
    return [action]

def set_variable(name):
    return {
        'WFWorkflowActionIdentifier': 'is.workflow.actions.setvariable',
        'WFWorkflowActionParameters': {
            'WFVariableName': name,
        },
    }

def get_variable(name):
    return {
        'Type': 'Variable',
        'VariableName': name,
    }

def magic_variable(action_uuid, output_name=''):
    return {
        'Type': 'ActionOutput',
        'OutputName': output_name,
        'OutputUUID': action_uuid,
    }

def token_string(parts):
    """Build a WFTextTokenString with mixed text and variable references."""
    result_string = ''
    attachments = {}
    pos = 0
    for part in parts:
        if isinstance(part, str):
            result_string += part
            pos += len(part)
        elif isinstance(part, dict):
            # Variable reference — insert a placeholder char
            placeholder = '\ufffc'
            range_key = f'{{{pos}, 1}}'
            attachments[range_key] = part
            result_string += placeholder
            pos += 1
    return {
        'Value': {
            'attachmentsByRange': attachments,
            'string': result_string,
        },
        'WFSerializationType': 'WFTextTokenString',
    }

def number_action(value):
    return {
        'WFWorkflowActionIdentifier': 'is.workflow.actions.number',
        'WFWorkflowActionParameters': {
            'WFNumberActionNumber': value,
        },
    }

def comment_action(text):
    return {
        'WFWorkflowActionIdentifier': 'is.workflow.actions.comment',
        'WFWorkflowActionParameters': {
            'WFCommentActionText': text,
        },
    }

def build_shortcut(server_url, api_token, person_name):
    actions = []
    
    # ── Comment: Header ──
    actions.append(comment_action(
        'Health → Locigram: Collects 48 half-hour health slots and POSTs to Locigram.\n'
        'Run nightly at 11:30 PM via Shortcuts Automation.'
    ))
    
    # ── Step 1: Set up variables ──
    actions.append(comment_action('── Configuration ──'))
    
    # Server URL
    actions.extend(text_action(server_url, 'ServerURL'))
    
    # API Token  
    actions.extend(text_action(api_token, 'APIToken'))
    
    # Person name
    actions.extend(text_action(person_name, 'PersonName'))
    
    # ── Step 2: Get today's date formatted ──
    actions.append(comment_action('── Get today\'s date ──'))
    
    # Current Date
    current_date_uuid = make_uuid()
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.date',
        'WFWorkflowActionParameters': {
            'WFDateActionMode': 'Current Date',
        },
        'UUID': current_date_uuid,
    })
    actions.append(set_variable('CurrentDate'))
    
    # Format date as yyyy-MM-dd
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.format.date',
        'WFWorkflowActionParameters': {
            'WFDateFormatStyle': 'Custom',
            'WFDateFormatString': 'yyyy-MM-dd',
            'WFInput': {
                'Value': get_variable('CurrentDate'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('TodayStr'))
    
    # ── Step 3: Initialize the memories list ──
    actions.append(comment_action('── Initialize memories list ──'))
    
    # Create empty list
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.list',
        'WFWorkflowActionParameters': {
            'WFItems': [],
        },
    })
    actions.append(set_variable('AllMemories'))
    
    # ── Step 4: Loop 48 times (one per 30-min slot) ──
    actions.append(comment_action('── Loop: 48 half-hour slots (midnight to 11:30pm) ──'))
    
    repeat_uuid = make_uuid()
    repeat_index_uuid = make_uuid()
    
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.count',
        'WFWorkflowActionParameters': {
            'WFRepeatCount': 48,
            'GroupingIdentifier': repeat_uuid,
            'WFControlFlowMode': 0,  # Start of repeat
        },
    })
    
    # ── Inside the loop ──
    
    # Calculate hour = (RepeatIndex - 1) / 2, floor
    # Calculate minute = ((RepeatIndex - 1) % 2) * 30
    
    # Get repeat index
    actions.append(comment_action('Calculate slot time from index'))
    
    # RepeatIndex - 1
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.math',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': get_variable('Repeat Index'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFMathOperation': '-',
            'WFMathOperand': 1,
        },
    })
    actions.append(set_variable('ZeroIndex'))
    
    # Hour = ZeroIndex / 2 (rounded down)
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.math',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': get_variable('ZeroIndex'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFMathOperation': '/',
            'WFMathOperand': 2,
        },
    })
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.round',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': {
                    'Type': 'Variable',
                    'VariableName': 'Calculation Result',
                },
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFRoundMode': 'Always Round Down',
        },
    })
    actions.append(set_variable('SlotHour'))
    
    # Minute = (ZeroIndex % 2) * 30
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.math',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': get_variable('ZeroIndex'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFMathOperation': 'Modulus',
            'WFMathOperand': 2,
        },
    })
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.math',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': {
                    'Type': 'Variable',
                    'VariableName': 'Calculation Result',
                },
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFMathOperation': '×',
            'WFMathOperand': 30,
        },
    })
    actions.append(set_variable('SlotMinute'))
    
    # Build slot start date: "Today at HH:MM"
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                get_variable('TodayStr'),
                ' ',
                get_variable('SlotHour'),
                ':',
                get_variable('SlotMinute'),
            ]),
        },
    })
    actions.append(set_variable('SlotTimeStr'))
    
    # Parse as date
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.detect.date',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': get_variable('SlotTimeStr'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('SlotStart'))
    
    # Slot end = SlotStart + 30 minutes
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.adjustdate',
        'WFWorkflowActionParameters': {
            'WFDate': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFDuration': {
                'Value': {
                    'Magnitude': 30,
                    'Unit': 'min',
                },
                'WFSerializationType': 'WFQuantityFieldValue',
            },
        },
    })
    actions.append(set_variable('SlotEnd'))
    
    # Format SlotStart as ISO 8601 UTC
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.format.date',
        'WFWorkflowActionParameters': {
            'WFDateFormatStyle': 'Custom',
            'WFDateFormatString': "yyyy-MM-dd'T'HH:mm:ss'Z'",
            'WFInput': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFTimeZone': 'UTC',
        },
    })
    actions.append(set_variable('SlotISO'))
    
    # ── Query HealthKit ──
    actions.append(comment_action('Query HealthKit for this 30-min slot'))
    
    # Steps (sum)
    steps_uuid = make_uuid()
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.health.quantity.get',
        'WFWorkflowActionParameters': {
            'WFHKQuantityType': 'Step Count',
            'WFHKQuantityTypeIdentifier': 'HKQuantityTypeIdentifierStepCount',
            'WFHKSampleSortOrder': 'Oldest First',
            'WFHKSampleStartDate': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFHKSampleEndDate': {
                'Value': get_variable('SlotEnd'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
        'UUID': steps_uuid,
    })
    # Get statistics → sum
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.statistics',
        'WFWorkflowActionParameters': {
            'WFStatisticsOperation': 'Sum',
            'WFInput': {
                'Value': magic_variable(steps_uuid, 'Health Samples'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('SlotSteps'))
    
    # Heart Rate (avg, min, max)
    hr_uuid = make_uuid()
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.health.quantity.get',
        'WFWorkflowActionParameters': {
            'WFHKQuantityType': 'Heart Rate',
            'WFHKQuantityTypeIdentifier': 'HKQuantityTypeIdentifierHeartRate',
            'WFHKSampleSortOrder': 'Oldest First',
            'WFHKSampleStartDate': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFHKSampleEndDate': {
                'Value': get_variable('SlotEnd'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
        'UUID': hr_uuid,
    })
    # Average
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.statistics',
        'WFWorkflowActionParameters': {
            'WFStatisticsOperation': 'Average',
            'WFInput': {
                'Value': magic_variable(hr_uuid, 'Health Samples'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('HRAvg'))
    # Min
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.statistics',
        'WFWorkflowActionParameters': {
            'WFStatisticsOperation': 'Minimum',
            'WFInput': {
                'Value': magic_variable(hr_uuid, 'Health Samples'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('HRMin'))
    # Max
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.statistics',
        'WFWorkflowActionParameters': {
            'WFStatisticsOperation': 'Maximum',
            'WFInput': {
                'Value': magic_variable(hr_uuid, 'Health Samples'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('HRMax'))
    
    # Active Energy (sum)
    cal_uuid = make_uuid()
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.health.quantity.get',
        'WFWorkflowActionParameters': {
            'WFHKQuantityType': 'Active Energy',
            'WFHKQuantityTypeIdentifier': 'HKQuantityTypeIdentifierActiveEnergyBurned',
            'WFHKSampleSortOrder': 'Oldest First',
            'WFHKSampleStartDate': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFHKSampleEndDate': {
                'Value': get_variable('SlotEnd'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
        'UUID': cal_uuid,
    })
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.statistics',
        'WFWorkflowActionParameters': {
            'WFStatisticsOperation': 'Sum',
            'WFInput': {
                'Value': magic_variable(cal_uuid, 'Health Samples'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('ActiveCal'))
    
    # HRV (latest)
    hrv_uuid = make_uuid()
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.health.quantity.get',
        'WFWorkflowActionParameters': {
            'WFHKQuantityType': 'Heart Rate Variability',
            'WFHKQuantityTypeIdentifier': 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
            'WFHKSampleSortOrder': 'Latest First',
            'WFHKSampleLimit': 1,
            'WFHKSampleStartDate': {
                'Value': get_variable('SlotStart'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFHKSampleEndDate': {
                'Value': get_variable('SlotEnd'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
        'UUID': hrv_uuid,
    })
    actions.append(set_variable('HRV'))
    
    # ── Build the content string ──
    actions.append(comment_action('Build content string and metadata dict'))
    
    # Content: "HH:MM – {steps} steps, avg HR {hr}bpm (min {min}, max {max}), {cal} active cal"
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                get_variable('SlotHour'),
                ':',
                get_variable('SlotMinute'),
                ' – ',
                get_variable('SlotSteps'),
                ' steps, avg HR ',
                get_variable('HRAvg'),
                'bpm (min ',
                get_variable('HRMin'),
                ', max ',
                get_variable('HRMax'),
                '), ',
                get_variable('ActiveCal'),
                ' active cal, HRV ',
                get_variable('HRV'),
                'ms',
            ]),
        },
    })
    actions.append(set_variable('ContentStr'))
    
    # Build objectVal summary
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                get_variable('SlotSteps'),
                ' steps, ',
                get_variable('HRAvg'),
                'bpm avg HR, ',
                get_variable('ActiveCal'),
                ' cal',
            ]),
        },
    })
    actions.append(set_variable('ObjectVal'))
    
    # Build sourceRef
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                'health:',
                get_variable('TodayStr'),
                ':',
                get_variable('SlotHour'),
                ':',
                get_variable('SlotMinute'),
            ]),
        },
    })
    actions.append(set_variable('SourceRef'))
    
    # ── Build the JSON dictionary for this slot ──
    # We'll build it as a text block (JSON string) since nested dicts in Shortcuts
    # are extremely painful with the plist format
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                '{"content":"',
                get_variable('ContentStr'),
                '","occurredAt":"',
                get_variable('SlotISO'),
                '","sourceRef":"',
                get_variable('SourceRef'),
                '","preClassified":{"subject":"',
                get_variable('PersonName'),
                '","predicate":"health_slot","objectVal":"',
                get_variable('ObjectVal'),
                '","entities":["',
                get_variable('PersonName'),
                '"],"importance":"normal","durabilityClass":"permanent","category":"observation"},"metadata":{"hour":',
                get_variable('SlotHour'),
                ',"minute":',
                get_variable('SlotMinute'),
                ',"steps":',
                get_variable('SlotSteps'),
                ',"hr_avg":',
                get_variable('HRAvg'),
                ',"hr_min":',
                get_variable('HRMin'),
                ',"hr_max":',
                get_variable('HRMax'),
                ',"active_cal":',
                get_variable('ActiveCal'),
                ',"hrv":',
                get_variable('HRV'),
                '}}',
            ]),
        },
    })
    actions.append(set_variable('SlotJSON'))
    
    # Append to AllMemories list
    # In Shortcuts, we build a comma-separated text and wrap at the end
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                get_variable('AllMemories'),
                get_variable('SlotJSON'),
                ',',
            ]),
        },
    })
    actions.append(set_variable('AllMemories'))
    
    # ── End of repeat loop ──
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.count',
        'WFWorkflowActionParameters': {
            'GroupingIdentifier': repeat_uuid,
            'WFControlFlowMode': 2,  # End of repeat
        },
    })
    
    # ── Step 5: Build final payload and POST ──
    actions.append(comment_action('── Build final JSON payload and POST to Locigram ──'))
    
    # Remove trailing comma and wrap in batch format
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
        'WFWorkflowActionParameters': {
            'WFTextActionText': token_string([
                '{"memories":[',
                get_variable('AllMemories'),
                '],"defaults":{"sourceType":"health","locus":"personal/health","connector":"health"}}',
            ]),
        },
    })
    actions.append(set_variable('Payload'))
    
    # Remove the trailing comma before the ] (fix the JSON)
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.text.replace',
        'WFWorkflowActionParameters': {
            'WFInput': {
                'Value': get_variable('Payload'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFReplaceTextFind': ',]',
            'WFReplaceTextReplace': ']',
        },
    })
    actions.append(set_variable('CleanPayload'))
    
    # POST to Locigram
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
        'WFWorkflowActionParameters': {
            'WFURL': {
                'Value': get_variable('ServerURL'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
            'WFHTTPMethod': 'POST',
            'WFHTTPHeaders': {
                'Value': {
                    'WFDictionaryFieldValueItems': [
                        {
                            'WFItemType': 0,
                            'WFKey': {
                                'Value': {'attachmentsByRange': {}, 'string': 'Content-Type'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                            'WFValue': {
                                'Value': {'attachmentsByRange': {}, 'string': 'application/json'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                        },
                        {
                            'WFItemType': 0,
                            'WFKey': {
                                'Value': {'attachmentsByRange': {}, 'string': 'Authorization'},
                                'WFSerializationType': 'WFTextTokenString',
                            },
                            'WFValue': token_string(['Bearer ', get_variable('APIToken')]),
                        },
                    ],
                },
                'WFSerializationType': 'WFDictionaryFieldValue',
            },
            'WFHTTPBodyType': 'String',
            'WFHTTPTextBody': {
                'Value': get_variable('CleanPayload'),
                'WFSerializationType': 'WFTextTokenAttachment',
            },
        },
    })
    actions.append(set_variable('Response'))
    
    # Show result notification
    actions.append({
        'WFWorkflowActionIdentifier': 'is.workflow.actions.notification',
        'WFWorkflowActionParameters': {
            'WFNotificationActionBody': token_string([
                'Health data synced to Locigram: ',
                get_variable('Response'),
            ]),
            'WFNotificationActionTitle': {
                'Value': {'attachmentsByRange': {}, 'string': 'Health → Locigram ✅'},
                'WFSerializationType': 'WFTextTokenString',
            },
        },
    })
    
    # ── Build the shortcut plist ──
    shortcut = {
        'WFWorkflowActions': actions,
        'WFWorkflowClientVersion': '2702.0.4',
        'WFWorkflowHasShortcutInputVariables': False,
        'WFWorkflowIcon': {
            'WFWorkflowIconStartColor': 4274264319,  # Green
            'WFWorkflowIconGlyphNumber': 59446,       # Heart icon
        },
        'WFWorkflowImportQuestions': [],
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowTypes': ['NCWidget', 'WatchKit'],
    }
    
    return shortcut


def main():
    parser = argparse.ArgumentParser(description='Generate Apple Health → Locigram iOS Shortcut')
    parser.add_argument('--url', required=True, help='Webhook URL (e.g. https://mcp.locigram.ai/api/webhook/health)')
    parser.add_argument('--token', required=True, help='Palace API token')
    parser.add_argument('--name', default='Andrew Le', help='Person name for entities')
    parser.add_argument('--output', default='health-to-locigram.shortcut', help='Output filename')
    args = parser.parse_args()
    
    shortcut = build_shortcut(args.url, args.token, args.name)
    
    with open(args.output, 'wb') as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
    
    print(f'✅ Shortcut generated: {args.output}')
    print(f'   URL: {args.url}')
    print(f'   Name: {args.name}')
    print(f'   Actions: {len(shortcut["WFWorkflowActions"])}')
    print(f'\nDouble-click the file on macOS to import into Shortcuts.')
    print(f'Then set up a daily automation at 11:30 PM to run it.')


if __name__ == '__main__':
    main()
