# Wires the ReplayKit broadcast extension into the Xcode project that `cap add ios`
# generates. The project is created fresh on every run, so the target has to be
# added here rather than committed: a checked-in .xcodeproj would drift from the
# Capacitor template the moment Capacitor is upgraded.
#
# Run from the repository root after the sources have been copied into ios/App.
require 'xcodeproj'

root = File.expand_path('../..', __dir__)
project_path = File.join(root, 'ios/App/App.xcodeproj')
abort("missing #{project_path}") unless File.exist?(project_path)

project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'App' }
abort('the App target was not generated') unless app

if project.targets.any? { |target| target.name == 'SageBroadcast' }
  puts 'broadcast target already wired'
  exit 0
end

team = ENV['APPLE_TEAM_ID'].to_s
abort('APPLE_TEAM_ID is missing') if team.empty?
build_number = ENV.fetch('IOS_BUILD_NUMBER', '1')
version = ENV.fetch('IOS_MARKETING_VERSION', '1.0')

extension = project.new_target(:app_extension, 'SageBroadcast', :ios, '15.0')

# Group paths are relative to the group itself, so files are named by basename:
# 'SageBroadcast/SageBroadcast/SampleHandler.swift' is not where the file is.
extension_group = project.main_group.new_group('SageBroadcast', 'SageBroadcast')
handler = extension_group.new_file('SampleHandler.swift')
extension.source_build_phase.add_file_reference(handler)

app_group = project.main_group.find_subpath('App', false)
abort('the App group was not generated') unless app_group
plugin = app_group.new_file('SageBroadcastPlugin.swift')
app.source_build_phase.add_file_reference(plugin)

extension.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'us.innotel.sage.broadcast',
    'INFOPLIST_FILE' => 'SageBroadcast/Info.plist',
    # No entitlements: an App Group cannot be created through the App Store
    # Connect API, which is the only signing this project has, so an entitlement
    # here would fail to sign rather than do anything.
    'PRODUCT_NAME' => 'SageBroadcast',
    'WRAPPER_EXTENSION' => 'appex',
    # Automatic, deliberately: the extension gets its own bundle id here and has
    # no stored profile, so Xcode is what registers and signs it. Naming a
    # distribution identity on top of that is a conflict, not a pin.
    'CODE_SIGN_STYLE' => 'Automatic',
    'DEVELOPMENT_TEAM' => team,
    'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SKIP_INSTALL' => 'YES',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'CURRENT_PROJECT_VERSION' => build_number,
    'MARKETING_VERSION' => version,
    'LD_RUNPATH_SEARCH_PATHS' => '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'
  )
end

app.add_dependency(extension)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13' # PlugIns
embedded = embed.add_file_reference(extension.product_reference)
embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts "wired SageBroadcast (#{extension.uuid}) into #{project_path}"
