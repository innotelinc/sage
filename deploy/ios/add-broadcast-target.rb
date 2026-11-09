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

# In-app purchase lives in the app target: StoreKit is not available to the
# broadcast extension, and nothing about a screenshot needs a price.
store = app_group.new_file('SageStorePlugin.swift')
app.source_build_phase.add_file_reference(store)

# The audio session plugin is copied beside the others, and a file that is only
# on disk is never compiled. Without it Listen dies when the app goes to the
# background, which is the one thing the broadcast extension cannot fix.
audio = app_group.new_file('SageAudioSessionPlugin.swift')
app.source_build_phase.add_file_reference(audio)

# Signing used to be automatic for both targets, and that is what filled the account's
# certificate cap: a fresh runner has no private key for an existing development
# certificate, so every archive asked Apple for another one until the team had ten and
# the next build was refused with "Choose a certificate to revoke". The workflow now
# asks the API for an App Store profile per bundle id and passes its UUID here, so the
# archive signs with the single distribution certificate already in the keychain and
# mints nothing. Without the UUIDs — a local run — it falls back to automatic.
app_profile = ENV['APP_PROFILE_UUID'].to_s
ext_profile = ENV['EXT_PROFILE_UUID'].to_s
signing = lambda do |profile|
  if profile.empty?
    { 'CODE_SIGN_STYLE' => 'Automatic', 'DEVELOPMENT_TEAM' => team }
  else
    {
      'CODE_SIGN_STYLE' => 'Manual',
      'CODE_SIGN_IDENTITY' => 'iPhone Distribution',
      'PROVISIONING_PROFILE_SPECIFIER' => profile,
      'DEVELOPMENT_TEAM' => team,
    }
  end
end

extension.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'us.innotel.sage.broadcast',
    'INFOPLIST_FILE' => 'SageBroadcast/Info.plist',
    # No entitlements: an App Group cannot be created through the App Store
    # Connect API, which is the only signing this project has, so an entitlement
    # here would fail to sign rather than do anything.
    'PRODUCT_NAME' => 'SageBroadcast',
    'WRAPPER_EXTENSION' => 'appex',
    **signing.call(ext_profile),
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

# The app target signs the same way. Release only: a Debug configuration pointing at
# a distribution profile is a trap for anyone building the app on their own machine.
app.build_configurations.each do |config|
  next unless config.name == 'Release'
  config.build_settings.merge!(signing.call(app_profile))
end

app.add_dependency(extension)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13' # PlugIns
embedded = embed.add_file_reference(extension.product_reference)
embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts "wired SageBroadcast (#{extension.uuid}) into #{project_path}"
